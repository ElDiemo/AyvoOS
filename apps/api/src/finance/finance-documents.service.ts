import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  FINANCE_PAGE_SIZE,
  type CorrectFinanceDocumentRequest,
  type FinanceDocument,
  type FinanceDocumentDetail,
  type FinanceDocumentEvent,
  type FinanceDocumentKind,
  type FinanceDocumentListQuery,
  type FinanceDocumentPage,
  type FinanceDocumentStatus,
  type FinanceSupplier,
  type UploadFinanceDocumentFields,
  type VoidFinanceDocumentRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ProcurementService } from '../procurement/procurement.service.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';

/** Accepted originals, recognised by their content (never by name or declared type). */
const FORMATS: { type: string; ext: string; magic: number[] }[] = [
  { type: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { type: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
];

/** The metadata kept in every event snapshot (the history shows what changed). */
const SNAPSHOT_FIELDS = [
  'supplierId',
  'kind',
  'documentNumber',
  'issuedOn',
  'taxPointOn',
  'dueOn',
  'totalAmount',
  'currency',
  'description',
  'status',
] as const;
type Snapshot = Record<(typeof SNAPSHOT_FIELDS)[number], string | null>;

const include = {
  supplier: { select: { id: true, name: true } },
  creator: { select: { displayName: true } },
} satisfies Prisma.FinanceDocumentInclude;
type DocumentRecord = Prisma.FinanceDocumentGetPayload<{ include: typeof include }>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const dateOrNull = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);

/**
 * Finance — received documents (doc 039, N1). Owns finance_documents and their events; reads
 * suppliers only through ProcurementService. The original file is stored once and never
 * changed; metadata changes only through a new version with its event; nothing is deleted.
 */
@Injectable()
export class FinanceDocumentsService {
  private readonly logger = new Logger(FinanceDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly procurement: ProcurementService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async suppliers(): Promise<FinanceSupplier[]> {
    return (await this.procurement.listSuppliers(false)).map((s) => ({ id: s.id, name: s.name }));
  }

  /**
   * Receives a document: validates the file by content, stores it, records it with its first
   * event. Idempotent per requestId: the same request returns the same document; the same id
   * with other content is a conflict. The same file cannot be received twice while valid.
   */
  async receive(
    fields: UploadFinanceDocumentFields,
    file: { buffer: Buffer; originalname: string },
    actorId: string,
  ): Promise<FinanceDocumentDetail> {
    const format = FORMATS.find((t) => t.magic.every((b, i) => file.buffer[i] === b));
    if (!format) throw domainError(422, 'UNSUPPORTED_DOCUMENT', 'Nahrajte PDF, JPEG nebo PNG.');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const previous = await this.prisma.financeDocument.findUnique({
      where: { requestId: fields.requestId },
    });
    if (previous) {
      if (previous.sha256 !== sha256 || previous.createdBy !== actorId)
        throw domainError(409, 'IDEMPOTENCY_CONFLICT', 'Request id already used for another upload');
      return this.detail(previous.code);
    }
    const duplicate = await this.prisma.financeDocument.findFirst({
      where: { sha256, status: 'ACTIVE' },
      select: { code: true },
    });
    if (duplicate)
      throw domainError(409, 'DUPLICATE_DOCUMENT', `Tento soubor už je přijatý jako ${duplicate.code}.`);

    // File first, then the record: a failure in between leaves an unreferenced file (logged),
    // never a record without its file (ADR 0016).
    const storageKey = newStorageKey('finance-documents', format.ext);
    await this.storage.put(storageKey, file.buffer);
    try {
      const code = await this.prisma.$transaction(async (tx) => {
        await this.procurement.assertActiveSupplier(tx, fields.supplierId);
        const { first } = await allocateSerials(tx, 'finance_document', 1);
        const code = `FD-${String(first).padStart(6, '0')}`;
        const doc = await tx.financeDocument.create({
          data: {
            serial: first,
            code,
            ...this.metadata(fields),
            storageKey,
            sha256,
            byteSize: file.buffer.length,
            contentType: format.type,
            originalFilename: safeFilename(file.originalname, format.ext),
            createdBy: actorId,
            requestId: fields.requestId,
          },
        });
        await tx.financeDocumentEvent.create({
          data: {
            documentId: doc.id,
            version: 1,
            type: 'RECEIVED',
            snapshot: snapshotOf(doc),
            actorId,
          },
        });
        return code;
      });
      return this.detail(code);
    } catch (error) {
      this.logger.warn(`Unreferenced finance document file after failed insert: ${storageKey}`);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw domainError(409, 'DUPLICATE_DOCUMENT', 'Tento soubor nebo požadavek už je přijatý.');
      }
      throw error;
    }
  }

  async list(query: FinanceDocumentListQuery): Promise<FinanceDocumentPage> {
    const q = query.q?.trim();
    const where: Prisma.FinanceDocumentWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.issuedFrom || query.issuedTo
        ? {
            issuedOn: {
              ...(query.issuedFrom ? { gte: dateOrNull(query.issuedFrom)! } : {}),
              ...(query.issuedTo ? { lte: dateOrNull(query.issuedTo)! } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { code: { contains: q, mode: 'insensitive' } },
              { documentNumber: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
              { supplier: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.financeDocument.count({ where }),
      this.prisma.financeDocument.findMany({
        where,
        include,
        orderBy: [{ issuedOn: 'desc' }, { serial: 'desc' }],
        skip: (query.page - 1) * FINANCE_PAGE_SIZE,
        take: FINANCE_PAGE_SIZE,
      }),
    ]);
    return { items: rows.map(toDto), total, page: query.page, pageSize: FINANCE_PAGE_SIZE };
  }

  async detail(code: string): Promise<FinanceDocumentDetail> {
    const doc = await this.prisma.financeDocument.findUnique({
      where: { code },
      include: {
        ...include,
        events: { orderBy: { version: 'asc' }, include: { actor: { select: { displayName: true } } } },
      },
    });
    if (!doc) throw new NotFoundException('Doklad nenalezen');
    let before: Record<string, unknown> | null = null;
    const history: FinanceDocumentEvent[] = doc.events.map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      const changes: Record<string, [unknown, unknown]> = {};
      if (before)
        for (const k of SNAPSHOT_FIELDS) if (before[k] !== snap[k]) changes[k] = [before[k], snap[k]];
      before = snap;
      return {
        version: e.version,
        type: e.type as FinanceDocumentEvent['type'],
        reason: e.reason,
        actor: e.actor.displayName,
        occurredAt: e.occurredAt.toISOString(),
        changes,
      };
    });
    return { ...toDto(doc), history };
  }

  /** The original file for an authorised download (bytes exactly as received). */
  async content(code: string) {
    const doc = await this.prisma.financeDocument.findUnique({ where: { code } });
    if (!doc) throw new NotFoundException('Doklad nenalezen');
    return {
      bytes: await this.storage.get(doc.storageKey),
      contentType: doc.contentType,
      filename: `${doc.code}-${doc.originalFilename}`,
      sha256: doc.sha256,
    };
  }

  /** A metadata correction: the next version with a full snapshot and the reason. */
  async correct(
    code: string,
    input: CorrectFinanceDocumentRequest,
    actorId: string,
  ): Promise<FinanceDocumentDetail> {
    await this.prisma.$transaction(async (tx) => {
      const doc = await this.lock(tx, code, input.expectedVersion);
      if (input.supplierId !== doc.supplierId)
        await this.procurement.assertActiveSupplier(tx, input.supplierId);
      const updated = await tx.financeDocument.update({
        where: { id: doc.id },
        data: { ...this.metadata(input), version: doc.version + 1, updatedAt: new Date() },
      });
      if (JSON.stringify(snapshotOf(updated)) === JSON.stringify(snapshotOf(doc)))
        throw domainError(422, 'NOTHING_CHANGED', 'Údaje se nezměnily.');
      await tx.financeDocumentEvent.create({
        data: {
          documentId: doc.id,
          version: updated.version,
          type: 'CORRECTED',
          snapshot: snapshotOf(updated),
          reason: input.reason,
          actorId,
        },
      });
    });
    return this.detail(code);
  }

  /** Voids a document (it stays, with its file and history; it no longer counts). */
  async void(
    code: string,
    input: VoidFinanceDocumentRequest,
    actorId: string,
  ): Promise<FinanceDocumentDetail> {
    await this.prisma.$transaction(async (tx) => {
      const doc = await this.lock(tx, code, input.expectedVersion);
      const updated = await tx.financeDocument.update({
        where: { id: doc.id },
        data: { status: 'VOIDED', version: doc.version + 1, updatedAt: new Date() },
      });
      await tx.financeDocumentEvent.create({
        data: {
          documentId: doc.id,
          version: updated.version,
          type: 'VOIDED',
          snapshot: snapshotOf(updated),
          reason: input.reason,
          actorId,
        },
      });
    });
    return this.detail(code);
  }

  private async lock(tx: Prisma.TransactionClient, code: string, expectedVersion: number) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "finance_documents" WHERE "code" = ${code} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Doklad nenalezen');
    const doc = await tx.financeDocument.findUniqueOrThrow({ where: { id: rows[0]!.id } });
    if (doc.status === 'VOIDED')
      throw domainError(409, 'DOCUMENT_VOIDED', 'Zrušený doklad už nelze měnit.');
    if (doc.version !== expectedVersion)
      throw domainError(409, 'STALE_VERSION', 'Doklad mezitím změnil někdo jiný. Načtěte ho znovu.');
    return doc;
  }

  private metadata(f: UploadFinanceDocumentFields | CorrectFinanceDocumentRequest) {
    return {
      supplierId: f.supplierId,
      kind: f.kind,
      documentNumber: f.documentNumber,
      issuedOn: dateOrNull(f.issuedOn)!,
      taxPointOn: dateOrNull(f.taxPointOn),
      dueOn: dateOrNull(f.dueOn),
      totalAmount: f.totalAmount ?? null,
      currency: f.currency ?? null,
      description: f.description ?? null,
    };
  }
}

function snapshotOf(d: {
  supplierId: string;
  kind: string;
  documentNumber: string;
  issuedOn: Date;
  taxPointOn: Date | null;
  dueOn: Date | null;
  totalAmount: Prisma.Decimal | null;
  currency: string | null;
  description: string | null;
  status: string;
}): Snapshot {
  return {
    supplierId: d.supplierId,
    kind: d.kind,
    documentNumber: d.documentNumber,
    issuedOn: day(d.issuedOn),
    taxPointOn: day(d.taxPointOn),
    dueOn: day(d.dueOn),
    totalAmount: d.totalAmount === null ? null : d.totalAmount.toFixed(2),
    currency: d.currency,
    description: d.description,
    status: d.status,
  };
}

function toDto(d: DocumentRecord): FinanceDocument {
  return {
    id: d.id,
    code: d.code,
    supplier: d.supplier,
    kind: d.kind as FinanceDocumentKind,
    documentNumber: d.documentNumber,
    issuedOn: day(d.issuedOn)!,
    taxPointOn: day(d.taxPointOn),
    dueOn: day(d.dueOn),
    totalAmount: d.totalAmount === null ? null : d.totalAmount.toFixed(2),
    currency: d.currency,
    description: d.description,
    status: d.status as FinanceDocumentStatus,
    version: d.version,
    originalFilename: d.originalFilename,
    contentType: d.contentType,
    byteSize: d.byteSize,
    sha256: d.sha256,
    createdAt: d.createdAt.toISOString(),
    createdBy: d.creator.displayName,
  };
}

/** A safe display name of the original (no path, no control characters). */
export function safeFilename(name: string, ext: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : `doklad.${ext}`;
}
