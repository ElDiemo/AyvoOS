import type { LabelArtwork as LabelArtworkDto } from '@ayvo/types';
import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { LabelArtwork } from '../generated/prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { InvalidArtworkError, inspectArtwork, type InspectedArtwork } from './artwork-inspector.js';
import { svgToPdf } from './artwork-pdf.js';
import { ADMIN_API } from '../common/routes.js';

export interface ArtworkContent {
  bytes: Buffer;
  contentType: string;
}

@Injectable()
export class LabelArtworkService {
  private readonly logger = new Logger(LabelArtworkService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Validates, stores and registers uploaded artwork. The filename is informational only. */
  async upload(bytes: Buffer, originalFilename: string): Promise<LabelArtworkDto> {
    let inspected: InspectedArtwork;
    try {
      inspected = await inspectArtwork(bytes);
      if (inspected.format === 'SVG') await svgToPdf(bytes.toString('utf8'), 100, 100);
    } catch (error) {
      if (error instanceof InvalidArtworkError) throw new BadRequestException(error.message);
      this.logger.warn(
        `Artwork rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('The artwork file could not be processed');
    }

    const storageKey = newStorageKey('label-artworks', inspected.extension);
    await this.storage.put(storageKey, bytes);
    // File first, then the row: a failed insert leaves an unreferenced file (logged), never a
    // row without its file. Unreferenced files are harmless and can be swept later.
    const artwork = await this.prisma.labelArtwork
      .create({
        data: {
          format: inspected.format,
          contentType: inspected.contentType,
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          storageKey,
          originalFilename: sanitizeFilename(originalFilename),
          intrinsicWidth: inspected.intrinsicWidth,
          intrinsicHeight: inspected.intrinsicHeight,
        },
      })
      .catch((error: unknown) => {
        this.logger.error(`Artwork row not created; unreferenced file ${storageKey}`);
        throw error;
      });
    return toArtworkDto(artwork, inspected.suggestedSizeMm);
  }

  async getContent(id: string): Promise<ArtworkContent> {
    const artwork = await this.prisma.labelArtwork.findUnique({ where: { id } });
    if (!artwork) throw new NotFoundException('Artwork not found');
    return { bytes: await this.storage.get(artwork.storageKey), contentType: artwork.contentType };
  }
}

export function toArtworkDto(
  artwork: LabelArtwork,
  suggestedSizeMm: LabelArtworkDto['suggestedSizeMm'] = null,
): LabelArtworkDto {
  return {
    id: artwork.id,
    format: artwork.format,
    byteSize: artwork.byteSize,
    originalFilename: artwork.originalFilename,
    intrinsicWidth: artwork.intrinsicWidth,
    intrinsicHeight: artwork.intrinsicHeight,
    suggestedSizeMm,
    contentUrl: `${ADMIN_API}/label-artworks/${artwork.id}/content`,
    createdAt: artwork.createdAt.toISOString(),
  };
}

/** Keeps a short, printable name for display; it never reaches the filesystem. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return clean || 'artwork';
}
