import type {
  BottleCreationBatch as BottleCreationBatchDto,
  BottleCreationBatchListResponse,
  BottleDetail,
  BottleListQuery,
  BottleListResponse,
  LabelTemplateVersionRef,
  PublicBottlePassport,
} from '@ayvo/types';
import { publicTokenSchema } from '@ayvo/types';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { ENV, type Env } from '../config/env.js';
import { allocateSerials } from '../database/code-counters.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { BottleCreationBatch, BottleStatus } from '../generated/prisma/client.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';
import { publicQrUrl } from '../common/qr-policy.js';
import { generatePublicToken } from './public-token.js';
import { countCompletedReuseCycles } from './reuse-cycles.js';

/** What the label-production module needs to know about a creation batch. */
export interface BatchForPrinting {
  id: string;
  code: string;
  labelTemplateVersionId: string;
  quantityCreated: number;
}

/** What is printed on one label. */
export interface BottlePrintIdentity {
  id: string;
  code: string;
  publicToken: string;
}

/** Interactive transactions for up to 1000 bottles; generous, but bounded. */
const CREATE_TX_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const;
const CREATE_ATTEMPTS = 3;

/**
 * assets module application service: bottle identities, CREATED lifecycle events and creation
 * batches. Bottles are never deleted; identity columns never change (enforced by the database).
 */
@Injectable()
export class BottlesService {
  private readonly logger = new Logger(BottlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly labels: LabelTemplatesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Registers `quantity` new physical bottles in ONE transaction: the creation batch, every
   * bottle (code + public token) and exactly one CREATED event per bottle. Either all of it is
   * committed or nothing is. Codes come from gapless counters locked inside the transaction, so
   * concurrent registrations get disjoint, contiguous code ranges.
   */
  async createBatch(input: {
    requestId: string;
    labelTemplateVersionId: string;
    quantity: number;
  }): Promise<{ batch: BottleCreationBatchDto; replayed: boolean }> {
    // Idempotency: a retried request (same requestId) returns the batch it already created.
    const existing = await this.findReplay(input);
    if (existing) return { batch: existing, replayed: true };

    // Latest version of an active template only (historical versions stay for reproduction).
    const ref = await this.labels.getSelectableVersionRef(input.labelTemplateVersionId);

    for (let attempt = 1; ; attempt++) {
      try {
        const batch = await this.prisma.$transaction(
          (tx) => this.insertBatch(tx, input),
          CREATE_TX_OPTIONS,
        );
        return { batch: toBatchDto(batch, ref), replayed: false };
      } catch (error) {
        const uniqueViolation =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!uniqueViolation) throw error;
        // A concurrent request with the same requestId committed first: return its batch.
        const concurrent = await this.findReplay(input);
        if (concurrent) return { batch: concurrent, replayed: true };
        // Otherwise only a public-token collision is possible (2^-128 odds; serials come from
        // row-locked counters). The whole transaction was rolled back: retry.
        if (attempt >= CREATE_ATTEMPTS) throw error;
        this.logger.warn(`Unique violation while creating bottles (attempt ${attempt}); retrying`);
      }
    }
  }

  /** The batch created earlier for this requestId, or null. Rejects reuse with other input. */
  private async findReplay(input: {
    requestId: string;
    labelTemplateVersionId: string;
    quantity: number;
  }): Promise<BottleCreationBatchDto | null> {
    const batch = await this.prisma.bottleCreationBatch.findUnique({
      where: { clientRequestId: input.requestId },
    });
    if (!batch) return null;
    if (
      batch.labelTemplateVersionId !== input.labelTemplateVersionId ||
      batch.quantityRequested !== input.quantity
    ) {
      throw new ConflictException('This requestId was already used for a different registration');
    }
    const refs = await this.labels.getVersionRefs([batch.labelTemplateVersionId]);
    return toBatchDto(batch, requireRef(refs, batch.labelTemplateVersionId));
  }

  private async insertBatch(
    tx: Prisma.TransactionClient,
    {
      requestId,
      labelTemplateVersionId,
      quantity,
    }: { requestId: string; labelTemplateVersionId: string; quantity: number },
  ): Promise<BottleCreationBatch> {
    const now = new Date();
    // Re-check under a share lock on the template (archive / new version wait for us).
    await this.labels.assertSelectableInTransaction(tx, labelTemplateVersionId);
    // Lock order: template (share), batch counter, then bottle counter (see allocateSerials).
    const batchSerial = (await allocateSerials(tx, 'bottle_creation_batch', 1)).first;
    const range = await allocateSerials(tx, 'bottle', quantity);

    const batch = await tx.bottleCreationBatch.create({
      data: {
        serial: batchSerial,
        code: formatCode(CODE_PREFIX.bottleCreationBatch, batchSerial),
        clientRequestId: requestId,
        quantityRequested: quantity,
        quantityCreated: quantity,
        labelTemplateVersionId,
        firstBottleSerial: range.first,
        lastBottleSerial: range.last,
        createdAt: now,
      },
    });

    const bottles = await tx.bottle.createManyAndReturn({
      data: Array.from({ length: quantity }, (_, i) => {
        const serial = range.first + BigInt(i);
        return {
          serial,
          code: formatCode(CODE_PREFIX.bottle, serial),
          publicToken: generatePublicToken(),
          status: 'CREATED' as const,
          creationBatchId: batch.id,
          createdAt: now,
        };
      }),
      select: { id: true },
    });
    if (bottles.length !== quantity) throw new Error('Bottle insert count mismatch');

    await tx.bottleEvent.createMany({
      data: bottles.map((b) => ({
        bottleId: b.id,
        type: 'CREATED' as const,
        occurredAt: now,
        recordedAt: now,
        creationBatchId: batch.id,
      })),
    });
    return batch;
  }

  async list(query: BottleListQuery): Promise<BottleListResponse> {
    const where: Prisma.BottleWhereInput = {};
    const empty = { items: [], page: query.page, pageSize: query.pageSize, total: 0 };

    if (query.search) {
      const serial = parseCodeSerial(CODE_PREFIX.bottle, query.search);
      if (serial === null) return empty;
      where.serial = serial;
    }
    const batchFilter: Prisma.BottleCreationBatchWhereInput = {};
    if (query.batch) {
      const serial = parseCodeSerial(CODE_PREFIX.bottleCreationBatch, query.batch);
      if (serial === null) return empty;
      batchFilter.serial = serial;
    }
    if (query.templateId) {
      batchFilter.labelTemplateVersionId = {
        in: await this.labels.listVersionIds(query.templateId),
      };
    }
    if (Object.keys(batchFilter).length > 0) where.creationBatch = batchFilter;
    if (query.status) where.status = query.status;

    const [total, bottles] = await this.prisma.$transaction([
      this.prisma.bottle.count({ where }),
      this.prisma.bottle.findMany({
        where,
        orderBy: { serial: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { creationBatch: { select: { code: true, labelTemplateVersionId: true } } },
      }),
    ]);
    const refs = await this.labels.getVersionRefs(
      bottles.map((b) => b.creationBatch.labelTemplateVersionId),
    );
    return {
      items: bottles.map((b) => ({
        code: b.code,
        status: b.status,
        creationBatchCode: b.creationBatch.code,
        labelTemplate: requireRef(refs, b.creationBatch.labelTemplateVersionId),
        createdAt: b.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getByCode(code: string): Promise<BottleDetail> {
    const serial = parseCodeSerial(CODE_PREFIX.bottle, code);
    const bottle =
      serial === null
        ? null
        : await this.prisma.bottle.findUnique({
            where: { serial },
            include: {
              creationBatch: { select: { code: true, labelTemplateVersionId: true } },
              events: { orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }] },
            },
          });
    if (!bottle) throw new NotFoundException('Bottle not found');
    const refs = await this.labels.getVersionRefs([bottle.creationBatch.labelTemplateVersionId]);
    return {
      code: bottle.code,
      status: bottle.status,
      creationBatchCode: bottle.creationBatch.code,
      labelTemplate: requireRef(refs, bottle.creationBatch.labelTemplateVersionId),
      createdAt: bottle.createdAt.toISOString(),
      publicUrl: publicQrUrl(this.env.PUBLIC_QR_BASE_URL, bottle.publicToken),
      reuseCycles: countCompletedReuseCycles(bottle.events.map((e) => e.type)),
      labelAppliedAt:
        bottle.events.find((e) => e.type === 'LABEL_APPLIED')?.occurredAt.toISOString() ?? null,
      events: bottle.events.map((e) => ({
        type: e.type,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
      })),
    };
  }

  // --- physical label application (doc 018; orchestrated by the warehouse module) -------------

  /** The bottle behind a public token, or null. Not locked. */
  findByPublicToken(tx: Prisma.TransactionClient, token: string) {
    return tx.bottle.findUnique({
      where: { publicToken: token },
      select: { id: true, code: true, status: true, creationBatch: { select: { code: true } } },
    });
  }

  /** Locks the bottle row (lock order: request → bottle → balances) and returns its status. */
  async lockForLabelApplication(tx: Prisma.TransactionClient, bottleId: string) {
    const rows = await tx.$queryRaw<{ status: BottleStatus }[]>`
      SELECT "status" FROM "bottles" WHERE "id" = ${bottleId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Bottle not found');
    return rows[0].status;
  }

  /**
   * First physical label installation: CREATED → LABELED_EMPTY, the LABEL_APPLIED event and
   * the open LABEL component attachment, in the caller's transaction (which must also post the
   * stock consumption — the database refuses the commit otherwise).
   */
  async applyLabelInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      bottleId: string;
      occurredAt: Date;
      labelQrUrl: string;
      printJobId: string;
      printJobPosition: number;
    },
  ): Promise<{ eventId: string }> {
    const event = await tx.bottleEvent.create({
      data: { bottleId: input.bottleId, type: 'LABEL_APPLIED', occurredAt: input.occurredAt },
      select: { id: true },
    });
    await tx.bottle.update({ where: { id: input.bottleId }, data: { status: 'LABELED_EMPTY' } });
    await tx.bottleComponentAttachment.create({
      data: {
        bottleId: input.bottleId,
        componentType: 'LABEL',
        labelQrUrl: input.labelQrUrl,
        printJobId: input.printJobId,
        printJobPosition: input.printJobPosition,
        installedAt: input.occurredAt,
        installedEventId: event.id,
      },
    });
    return { eventId: event.id };
  }

  async statusAndCode(bottleId: string) {
    const bottle = await this.prisma.bottle.findUnique({
      where: { id: bottleId },
      select: { code: true, status: true },
    });
    if (!bottle) throw new NotFoundException('Bottle not found');
    return bottle;
  }

  /** The LABEL_APPLIED event of a bottle, or null. */
  labelAppliedEvent(bottleId: string, db: Prisma.TransactionClient = this.prisma) {
    return db.bottleEvent.findFirst({
      where: { bottleId, type: 'LABEL_APPLIED' },
      select: { id: true, occurredAt: true },
    });
  }

  /** Bottle identity + its component attachments (raw; print jobs are resolved by callers). */
  async physicalByCode(code: string) {
    const serial = parseCodeSerial(CODE_PREFIX.bottle, code);
    const bottle =
      serial === null
        ? null
        : await this.prisma.bottle.findUnique({
            where: { serial },
            select: {
              id: true,
              code: true,
              events: { where: { type: 'LABEL_APPLIED' }, select: { id: true, occurredAt: true } },
              components: { orderBy: { installedAt: 'asc' } },
            },
          });
    if (!bottle) throw new NotFoundException('Bottle not found');
    return bottle;
  }

  /** Bottle codes of events (for ledger and activity views). */
  async bottleCodesOfEvents(eventIds: readonly string[]): Promise<Map<string, string>> {
    const events = await this.prisma.bottleEvent.findMany({
      where: { id: { in: [...eventIds] } },
      select: { id: true, bottle: { select: { code: true } } },
    });
    return new Map(events.map((e) => [e.id, e.bottle.code]));
  }

  /** Most recent LABEL_APPLIED events. */
  recentLabelApplications(limit: number) {
    return this.prisma.bottleEvent.findMany({
      where: { type: 'LABEL_APPLIED' },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, occurredAt: true, bottle: { select: { code: true } } },
    });
  }

  async listBatches(page: number, pageSize: number): Promise<BottleCreationBatchListResponse> {
    const [total, batches] = await this.prisma.$transaction([
      this.prisma.bottleCreationBatch.count(),
      this.prisma.bottleCreationBatch.findMany({
        orderBy: { serial: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const refs = await this.labels.getVersionRefs(batches.map((b) => b.labelTemplateVersionId));
    return {
      items: batches.map((b) => toBatchDto(b, requireRef(refs, b.labelTemplateVersionId))),
      page,
      pageSize,
      total,
    };
  }

  async getBatchByCode(code: string): Promise<BottleCreationBatchDto> {
    const batch = await this.findBatch(code);
    const refs = await this.labels.getVersionRefs([batch.labelTemplateVersionId]);
    return toBatchDto(batch, requireRef(refs, batch.labelTemplateVersionId));
  }

  /** For label-production: the batch behind a code (404 if unknown). */
  async getBatchForPrinting(code: string): Promise<BatchForPrinting> {
    const batch = await this.findBatch(code);
    return {
      id: batch.id,
      code: batch.code,
      labelTemplateVersionId: batch.labelTemplateVersionId,
      quantityCreated: batch.quantityCreated,
    };
  }

  /** For label-production: the human-readable code of a batch. */
  async getBatchCode(batchId: string): Promise<string> {
    const batch = await this.prisma.bottleCreationBatch.findUnique({
      where: { id: batchId },
      select: { code: true },
    });
    if (!batch) throw new NotFoundException('Creation batch not found');
    return batch.code;
  }

  /** For label-production: internal ids of the given batch codes (unknown codes are omitted). */
  async getBatchIds(codes: readonly string[]): Promise<Map<string, string>> {
    const batches = await this.prisma.bottleCreationBatch.findMany({
      where: { code: { in: [...codes] } },
      select: { id: true, code: true },
    });
    return new Map(batches.map((b) => [b.code, b.id]));
  }

  /** For label-production: the bottles of a batch in code order (= page order). */
  async listBatchBottlesForPrinting(batchId: string): Promise<BottlePrintIdentity[]> {
    return this.prisma.bottle.findMany({
      where: { creationBatchId: batchId },
      orderBy: { serial: 'asc' },
      select: { id: true, code: true, publicToken: true },
    });
  }

  /** For label-production: print identities of specific bottles, in the requested order. */
  async getPrintIdentities(bottleIds: readonly string[]): Promise<BottlePrintIdentity[]> {
    const bottles = await this.prisma.bottle.findMany({
      where: { id: { in: [...bottleIds] } },
      select: { id: true, code: true, publicToken: true },
    });
    const byId = new Map(bottles.map((b) => [b.id, b]));
    return bottleIds.map((id) => {
      const bottle = byId.get(id);
      if (!bottle) throw new Error('Bottle of print job not found');
      return bottle;
    });
  }

  /** Public passport: resolved by the opaque token only, whitelisted fields only. */
  async getPassport(token: string): Promise<PublicBottlePassport> {
    const bottle = publicTokenSchema.safeParse(token).success
      ? await this.prisma.bottle.findUnique({
          where: { publicToken: token },
          select: {
            code: true,
            events: {
              orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }],
              select: { type: true },
            },
          },
        })
      : null;
    if (!bottle) throw new NotFoundException('Bottle not found');
    return {
      bottleCode: bottle.code,
      reuseCycles: countCompletedReuseCycles(bottle.events.map((e) => e.type)),
    };
  }

  private async findBatch(code: string): Promise<BottleCreationBatch> {
    const serial = parseCodeSerial(CODE_PREFIX.bottleCreationBatch, code);
    const batch =
      serial === null
        ? null
        : await this.prisma.bottleCreationBatch.findUnique({ where: { serial } });
    if (!batch) throw new NotFoundException('Creation batch not found');
    return batch;
  }
}

function toBatchDto(
  batch: BottleCreationBatch,
  ref: LabelTemplateVersionRef,
): BottleCreationBatchDto {
  return {
    code: batch.code,
    quantityRequested: batch.quantityRequested,
    quantityCreated: batch.quantityCreated,
    firstBottleCode: formatCode(CODE_PREFIX.bottle, batch.firstBottleSerial),
    lastBottleCode: formatCode(CODE_PREFIX.bottle, batch.lastBottleSerial),
    labelTemplate: ref,
    createdAt: batch.createdAt.toISOString(),
  };
}

function requireRef(
  refs: Map<string, LabelTemplateVersionRef>,
  versionId: string,
): LabelTemplateVersionRef {
  const ref = refs.get(versionId);
  if (!ref) throw new Error('Label template version of a creation batch is missing');
  return ref;
}
