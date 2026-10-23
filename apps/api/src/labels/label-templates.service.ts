import type {
  CreateLabelTemplateVersionResponse,
  LabelElement,
  LabelLayout,
  LabelTemplateDetail,
  LabelTemplateSummary,
  LabelTemplateVersion as LabelTemplateVersionDto,
  LabelTemplateVersionRef,
} from '@ayvo/types';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  LabelArtwork,
  LabelTemplate,
  LabelTemplateElement,
  LabelTemplateVersion,
} from '../generated/prisma/client.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import { toArtworkDto } from './label-artwork.service.js';
import { requireQrLabelSettings } from './qr-label-settings.js';

/** Artwork and label proportions may differ by at most 1% (the artwork fills the label). */
export const ASPECT_RATIO_TOLERANCE = 0.01;

type VersionRow = LabelTemplateVersion & {
  template: LabelTemplate;
  artwork: LabelArtwork;
  elements: LabelTemplateElement[];
};

const VERSION_INCLUDE = {
  template: true,
  artwork: true,
  elements: { orderBy: { position: 'asc' } },
} as const satisfies Prisma.LabelTemplateVersionInclude;

/** Everything needed to render labels of one version, exactly as it was saved. */
export interface RenderableTemplateVersion {
  ref: LabelTemplateVersionRef;
  widthMm: number;
  heightMm: number;
  artwork: { format: LabelArtwork['format']; bytes: Buffer };
  elements: LabelElement[];
}

/**
 * Label templates and their immutable versions. Saving a changed layout always creates a new
 * version; existing versions (and therefore historical print output) never change. The database
 * enforces this too (immutability triggers, ADR 0014).
 */
@Injectable()
export class LabelTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async list(): Promise<LabelTemplateSummary[]> {
    const templates = await this.prisma.labelTemplate.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { versions: true } },
        versions: { orderBy: { versionNumber: 'desc' }, take: 1, include: VERSION_INCLUDE },
      },
    });
    return templates.flatMap((t) => {
      const latest = t.versions[0];
      if (!latest) return [];
      return [
        {
          id: t.id,
          name: t.name,
          createdAt: t.createdAt.toISOString(),
          archivedAt: t.archivedAt?.toISOString() ?? null,
          versionCount: t._count.versions,
          latestVersion: toVersionDto(latest),
        },
      ];
    });
  }

  async get(id: string): Promise<LabelTemplateDetail> {
    const template = await this.prisma.labelTemplate.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, include: VERSION_INCLUDE } },
    });
    if (!template || template.versions.length === 0)
      throw new NotFoundException('Label template not found');
    return {
      id: template.id,
      name: template.name,
      createdAt: template.createdAt.toISOString(),
      archivedAt: template.archivedAt?.toISOString() ?? null,
      versions: template.versions.map(toVersionDto),
    };
  }

  async getVersion(versionId: string): Promise<LabelTemplateVersionDto> {
    const version = await this.prisma.labelTemplateVersion.findUnique({
      where: { id: versionId },
      include: VERSION_INCLUDE,
    });
    if (!version) throw new NotFoundException('Label template version not found');
    return toVersionDto(version);
  }

  /** Creates a template together with its first version (v1). */
  async create(name: string, layout: LabelLayout): Promise<LabelTemplateVersionDto> {
    await this.validateLayout(layout);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const template = await tx.labelTemplate.create({ data: { name } });
        return this.insertVersion(tx, template.id, 1, layout);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A label template named "${name}" already exists`);
      }
      throw error;
    }
  }

  /**
   * Saves a layout as the next version. If it equals the latest version nothing is created.
   * The template row is locked, so concurrent saves get consecutive version numbers.
   */
  async createVersion(
    templateId: string,
    layout: LabelLayout,
  ): Promise<CreateLabelTemplateVersionResponse> {
    await this.validateLayout(layout);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; archived_at: Date | null }[]>`
        SELECT id, archived_at FROM label_templates WHERE id = ${templateId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Label template not found');
      if (locked[0]!.archived_at) {
        throw new ConflictException(
          'The template is archived: restore it before saving a new version',
        );
      }

      const latest = await tx.labelTemplateVersion.findFirst({
        where: { templateId },
        orderBy: { versionNumber: 'desc' },
        include: VERSION_INCLUDE,
      });
      if (latest && sameLayout(latest, layout)) {
        return { created: false, version: toVersionDto(latest) };
      }
      const version = await this.insertVersion(
        tx,
        templateId,
        (latest?.versionNumber ?? 0) + 1,
        layout,
      );
      return { created: true, version };
    });
  }

  /**
   * Archives (hides) or restores a template. Archived templates keep all versions for historical
   * reproduction but cannot be used for new creation batches. Templates are never deleted.
   */
  async setArchived(id: string, archived: boolean): Promise<LabelTemplateDetail> {
    const updated = await this.prisma.labelTemplate.updateMany({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
    if (updated.count === 0) throw new NotFoundException('Label template not found');
    return this.get(id);
  }

  /**
   * The version new bottles may be registered with: it must be the LATEST version of an ACTIVE
   * (not archived) template. Historical batches and print jobs keep their recorded versions.
   */
  async getSelectableVersionRef(versionId: string): Promise<LabelTemplateVersionRef> {
    const version = await this.prisma.labelTemplateVersion.findUnique({
      where: { id: versionId },
      include: { template: true },
    });
    if (!version) throw new BadRequestException('Unknown label template version');
    if (version.template.archivedAt) {
      throw new BadRequestException(`Label template ${version.template.name} is archived`);
    }
    const latest = await this.prisma.labelTemplateVersion.findFirst({
      where: { templateId: version.templateId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true },
    });
    if (latest?.id !== version.id) {
      throw new BadRequestException(
        `${version.template.name} v${version.versionNumber} is not the latest version (v${latest?.versionNumber}); new bottles use the latest version`,
      );
    }
    return toVersionRef(version);
  }

  /**
   * Same rule as getSelectableVersionRef, checked INSIDE the caller's transaction with the
   * template row share-locked: a concurrent archive or new version (both lock that row) waits
   * until the caller commits, so a batch can never be created against a version that stopped
   * being selectable in between.
   */
  async assertSelectableInTransaction(
    tx: Prisma.TransactionClient,
    versionId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      { archived: boolean; version_number: number; latest: number }[]
    >`
      SELECT t.archived_at IS NOT NULL AS archived, v.version_number,
             (SELECT max(l.version_number) FROM label_template_versions l WHERE l.template_id = t.id) AS latest
        FROM label_template_versions v
        JOIN label_templates t ON t.id = v.template_id
       WHERE v.id = ${versionId}::uuid
         FOR SHARE OF t`;
    const row = rows[0];
    if (!row) throw new BadRequestException('Unknown label template version');
    if (row.archived) throw new BadRequestException('The label template is archived');
    if (row.version_number !== row.latest) {
      throw new BadRequestException('The label template version is no longer the latest version');
    }
  }

  /** Display references ("mydlo1 v1") for a set of version ids. */
  async getVersionRefs(
    versionIds: readonly string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, LabelTemplateVersionRef>> {
    const versions = await db.labelTemplateVersion.findMany({
      where: { id: { in: [...new Set(versionIds)] } },
      include: { template: true },
    });
    return new Map(versions.map((v) => [v.id, toVersionRef(v)]));
  }

  /** Ids of all versions of a template (for filtering bottles by template). */
  async listVersionIds(templateId: string): Promise<string[]> {
    const versions = await this.prisma.labelTemplateVersion.findMany({
      where: { templateId },
      select: { id: true },
    });
    return versions.map((v) => v.id);
  }

  async getRenderableVersion(versionId: string): Promise<RenderableTemplateVersion> {
    const version = await this.prisma.labelTemplateVersion.findUnique({
      where: { id: versionId },
      include: VERSION_INCLUDE,
    });
    if (!version) throw new NotFoundException('Label template version not found');
    const dto = toVersionDto(version);
    return {
      ref: toVersionRef(version),
      widthMm: dto.widthMm,
      heightMm: dto.heightMm,
      artwork: {
        format: version.artwork.format,
        bytes: await this.storage.get(version.artwork.storageKey),
      },
      elements: dto.elements,
    };
  }

  /** The widths (mm) of a version's QR elements, for the print-time size check. */
  async qrElementWidths(versionId: string): Promise<number[]> {
    const elements = await this.prisma.labelTemplateElement.findMany({
      where: { versionId, type: 'QR_CODE' },
      select: { widthMm: true },
    });
    return elements.map((e) => e.widthMm.toNumber());
  }

  private async validateLayout(layout: LabelLayout): Promise<void> {
    const artwork = await this.prisma.labelArtwork.findUnique({ where: { id: layout.artworkId } });
    if (!artwork) throw new BadRequestException('Unknown artwork: upload the artwork first');

    const artworkRatio = artwork.intrinsicWidth / artwork.intrinsicHeight;
    const labelRatio = layout.widthMm / layout.heightMm;
    if (Math.abs(artworkRatio / labelRatio - 1) > ASPECT_RATIO_TOLERANCE) {
      const expectedHeight = Math.round((layout.widthMm / artworkRatio) * 100) / 100;
      throw new BadRequestException(
        `The artwork proportions do not match the label size (for a width of ${layout.widthMm} mm ` +
          `the artwork needs a height of about ${expectedHeight} mm)`,
      );
    }
    const qrElements = layout.elements.filter((element) => element.type === 'QR_CODE');
    if (qrElements.length === 0) return;
    // A QR element needs the validated QR settings (refused without them, qr-label-settings.ts).
    const { minSizeMm } = requireQrLabelSettings(this.env);
    for (const element of qrElements) {
      if (element.widthMm < minSizeMm) {
        throw new BadRequestException(
          `The QR code must be at least ${minSizeMm} mm wide (quiet zone included)`,
        );
      }
    }
  }

  private async insertVersion(
    tx: Prisma.TransactionClient,
    templateId: string,
    versionNumber: number,
    layout: LabelLayout,
  ): Promise<LabelTemplateVersionDto> {
    const version = await tx.labelTemplateVersion.create({
      data: {
        templateId,
        versionNumber,
        widthMm: layout.widthMm,
        heightMm: layout.heightMm,
        artworkId: layout.artworkId,
        elements: {
          create: layout.elements.map((e, position) => ({
            type: e.type,
            position,
            xMm: e.xMm,
            yMm: e.yMm,
            widthMm: e.widthMm,
            heightMm: e.heightMm,
            rotationDeg: e.rotationDeg,
          })),
        },
      },
      include: VERSION_INCLUDE,
    });
    return toVersionDto(version);
  }
}

function toVersionRef(
  v: LabelTemplateVersion & { template: LabelTemplate },
): LabelTemplateVersionRef {
  return {
    versionId: v.id,
    templateId: v.templateId,
    templateName: v.template.name,
    versionNumber: v.versionNumber,
    label: `${v.template.name} v${v.versionNumber}`,
  };
}

function toVersionDto(v: VersionRow): LabelTemplateVersionDto {
  return {
    ...toVersionRef(v),
    widthMm: v.widthMm.toNumber(),
    heightMm: v.heightMm.toNumber(),
    artwork: toArtworkDto(v.artwork),
    elements: v.elements.map((e) => ({
      type: e.type,
      xMm: e.xMm.toNumber(),
      yMm: e.yMm.toNumber(),
      widthMm: e.widthMm.toNumber(),
      heightMm: e.heightMm.toNumber(),
      rotationDeg: 0 as const,
    })),
    createdAt: v.createdAt.toISOString(),
  };
}

function sameLayout(version: VersionRow, layout: LabelLayout): boolean {
  const current = toVersionDto(version);
  return (
    version.artworkId === layout.artworkId &&
    current.widthMm === layout.widthMm &&
    current.heightMm === layout.heightMm &&
    JSON.stringify(current.elements) === JSON.stringify(layout.elements.map(normalizeElement))
  );
}

function normalizeElement(e: LabelElement): LabelElement {
  return {
    type: e.type,
    xMm: e.xMm,
    yMm: e.yMm,
    widthMm: e.widthMm,
    heightMm: e.heightMm,
    rotationDeg: 0,
  };
}
