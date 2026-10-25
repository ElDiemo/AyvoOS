import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  FINANCE_EXPORT_REQUIRED,
  FINANCE_PAGE_SIZE,
  type CorrectFinanceDocumentRequest,
  type FinanceDocument,
  type FinanceDocumentDetail,
  type FinanceDocumentEvent,
  type FinanceDocumentKind,
  type FinanceDocumentListQuery,
  type FinanceDocumentPage,
  type FinanceDocumentSource,
  type FinanceDocumentStatus,
  type FinanceExportRequiredField,
  type FinanceSupplier,
  type TakeOverCandidate,
  type TakeOverSupplierDocumentRequest,
  type UploadFinanceDocumentFields,
  type VoidFinanceDocumentRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { CoreClient } from './core-client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

/** Finance's own uploads are PDF only (doc 039 §3), recognised by content, never by name/type. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Kinds of supplier documents as finance kinds (the user may correct it afterwards). */
const TAKEOVER_KIND: Record<string, FinanceDocumentKind> = {
  INVOICE: 'INVOICE',
  DELIVERY_NOTE: 'OTHER',
  OTHER_APPROVED: 'OTHER',
};

/** The metadata kept in every event snapshot (the history shows what changed). */
const SNAPSHOT_FIELDS = [
  'supplierId',
  'supplierName',
  'kind',
  'documentNumber',
  'issuedOn',
  'taxPointOn',
  'dueOn',
  'totalAmount',
  'currency',
  'description',
  'handoverMonth',
  'status',
] as const;
type Snapshot = Record<(typeof SNAPSHOT_FIELDS)[number], string | null>;
type DocumentRow = Prisma.DocumentGetPayload<object>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const month = (d: Date | null) => (d ? d.toISOString().slice(0, 7) : null);
const dateOrNull = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
const monthOrNull = (s: string | null | undefined) => (s ? new Date(`${s}-01T00:00:00Z`) : null);

/**
 * Finance — received documents (doc 039, N1) in the Finance unit (ADR 0039). Owns schema
 * `finance`; suppliers, supplier documents and the user come only from the core contract
 * (CoreClient) for the current caller. An original is either Finance's own PDF (stored once,
 * never changed) or a referenced supplier document (no copy; its bytes come through the core,
 * which checks the user's access to its site on every read). Metadata may be incomplete
 * ("k doplnění") and changes only through a new version with its event; nothing is deleted.
 */
@Injectable()
export class FinanceDocumentsService {
  private readonly logger = new Logger(FinanceDocumentsService.name);

  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    private readonly core: CoreClient,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async suppliers(caller: FinanceCaller): Promise<FinanceSupplier[]> {
    return (await this.core.suppliers(caller.sessionToken)).map((s) => ({
      id: s.id,
      name: s.name,
    }));
  }

  /**
   * Receives Finance's own original (PDF): validates it by content, stores it, records it with
   * its first event. Idempotent per requestId over the complete original request (metadata,
   * file hash, author): a replay returns the same document even after later corrections; the
   * same id with anything else is IDEMPOTENCY_CONFLICT. A valid file is received only once.
   */
  async receive(
    fields: UploadFinanceDocumentFields,
    file: { buffer: Buffer; originalname: string },
    caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    if (!PDF_MAGIC.every((b, i) => file.buffer[i] === b))
      throw domainError(422, 'UNSUPPORTED_DOCUMENT', 'Nahrajte originál dokladu jako PDF.');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const supplierName = fields.supplierId
      ? await this.activeSupplierName(caller, fields.supplierId)
      : null;
    const { userId, displayName } = caller.principal;
    const { result } = await this.operations.run(
      'FINANCE_DOCUMENT_RECEIVE',
      fields.requestId,
      { ...canonical(fields), sha256, actorId: userId },
      async (tx) => {
        await assertNotReceived(tx, sha256);
        // File first, then the record: a failure in between leaves an unreferenced file
        // (logged), never a record without its file (ADR 0016).
        const storageKey = newStorageKey('finance-documents', 'pdf');
        await this.storage.put(storageKey, file.buffer);
        try {
          return {
            code: await insert(tx, {
              ...metadata(fields),
              supplierName,
              source: 'UPLOAD',
              storageKey,
              sha256,
              byteSize: file.buffer.length,
              contentType: 'application/pdf',
              originalFilename: safeFilename(file.originalname, 'pdf'),
              createdBy: userId,
              createdByName: displayName,
              requestId: fields.requestId,
            }),
          };
        } catch (error) {
          this.logger.warn(`Unreferenced finance document file after failed insert: ${storageKey}`);
          throw duplicateOr(error);
        }
      },
    );
    return this.detail(result.code);
  }

  /**
   * Supplier documents of Sklad the user may take over (the core lists only the sites whose
   * paperwork the user may read), marked when superseded or already taken over.
   */
  async takeOverCandidates(
    caller: FinanceCaller,
    supplierId?: string,
  ): Promise<TakeOverCandidate[]> {
    if (!caller.principal.permissions.includes('procurement:documents_read')) return [];
    const docs = await this.core.supplierDocuments(caller.sessionToken, supplierId);
    const taken = await this.prisma.document.findMany({
      where: { supplierDocumentId: { in: docs.map((d) => d.id) }, status: 'ACTIVE' },
      select: { code: true, supplierDocumentId: true },
    });
    const by = new Map(taken.map((t) => [t.supplierDocumentId, t.code]));
    return docs.map((d) => ({
      id: d.id,
      supplier: d.supplier,
      kind: d.kind,
      documentNumber: d.documentNumber,
      issuedOn: d.issuedOn,
      originalFilename: d.originalFilename,
      byteSize: d.byteSize,
      siteCode: d.siteCode,
      superseded: d.superseded,
      takenOverBy: by.get(d.id) ?? null,
    }));
  }

  /**
   * Takes over an existing supplier document: one finance document referencing it — no second
   * copy of the file, no receipt, stock movement or price. The core checks the user's access to
   * its site now — also on a replay of the same request; another site's document is "not found".
   * One valid finance document per supplier document (DB).
   */
  async takeOver(
    input: TakeOverSupplierDocumentRequest,
    caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    const src = await this.core.supplierDocument(caller.sessionToken, input.supplierDocumentId);
    const { userId, displayName } = caller.principal;
    const { result } = await this.operations.run(
      'FINANCE_DOCUMENT_TAKEOVER',
      input.requestId,
      {
        supplierDocumentId: input.supplierDocumentId,
        kind: input.kind ?? null,
        handoverMonth: input.handoverMonth ?? null,
        description: input.description ?? null,
        actorId: userId,
      },
      async (tx) => {
        const taken = await tx.document.findFirst({
          where: { supplierDocumentId: src.id, status: 'ACTIVE' },
          select: { code: true },
        });
        if (taken)
          throw domainError(
            409,
            'ALREADY_TAKEN_OVER',
            `Tento doklad skladu už je ve Financích jako ${taken.code}.`,
          );
        await assertNotReceived(tx, src.sha256);
        try {
          return {
            code: await insert(tx, {
              supplierId: src.supplier.id,
              supplierName: src.supplier.name,
              kind: input.kind ?? TAKEOVER_KIND[src.kind] ?? 'OTHER',
              documentNumber: src.documentNumber,
              issuedOn: dateOrNull(src.issuedOn),
              taxPointOn: null,
              dueOn: null,
              totalAmount: null,
              currency: null,
              description: input.description ?? null,
              handoverMonth: monthOrNull(input.handoverMonth),
              source: 'SUPPLIER_DOCUMENT',
              supplierDocumentId: src.id,
              sourceSiteId: src.siteId,
              sourceSiteCode: src.siteCode,
              storageKey: null,
              sha256: src.sha256,
              byteSize: src.byteSize,
              contentType: src.contentType,
              originalFilename: safeFilename(src.originalFilename, 'pdf'),
              createdBy: userId,
              createdByName: displayName,
              requestId: input.requestId,
            }),
          };
        } catch (error) {
          throw duplicateOr(error);
        }
      },
    );
    return this.detail(result.code);
  }

  async list(query: FinanceDocumentListQuery): Promise<FinanceDocumentPage> {
    const q = query.q?.trim();
    const where: Prisma.DocumentWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.handoverMonth ? { handoverMonth: monthOrNull(query.handoverMonth)! } : {}),
      ...(query.incomplete
        ? {
            OR: [
              { supplierId: null },
              { documentNumber: null },
              { issuedOn: null },
              { handoverMonth: null },
            ],
          }
        : {}),
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
            AND: {
              OR: [
                { code: { contains: q, mode: 'insensitive' } },
                { documentNumber: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
                { supplierName: { contains: q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy: { serial: 'desc' },
        skip: (query.page - 1) * FINANCE_PAGE_SIZE,
        take: FINANCE_PAGE_SIZE,
      }),
    ]);
    return { items: rows.map(toDto), total, page: query.page, pageSize: FINANCE_PAGE_SIZE };
  }

  async detail(code: string): Promise<FinanceDocumentDetail> {
    const doc = await this.prisma.document.findUnique({
      where: { code },
      include: { events: { orderBy: { version: 'asc' } } },
    });
    if (!doc) throw new NotFoundException('Doklad nenalezen');
    let before: Record<string, unknown> | null = null;
    const history: FinanceDocumentEvent[] = doc.events.map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      const changes: Record<string, [unknown, unknown]> = {};
      if (before)
        for (const k of SNAPSHOT_FIELDS) {
          if (k === 'supplierName') continue; // shown as the supplier change
          if (before[k] !== snap[k])
            changes[k] =
              k === 'supplierId'
                ? [before.supplierName ?? null, snap.supplierName ?? null]
                : [before[k], snap[k]];
        }
      before = snap;
      return {
        version: e.version,
        type: e.type as FinanceDocumentEvent['type'],
        reason: e.reason,
        actor: e.actorName,
        occurredAt: e.occurredAt.toISOString(),
        changes,
      };
    });
    return { ...toDto(doc), history };
  }

  /** The original file for an authorised download (bytes exactly as received). */
  async content(code: string, caller: FinanceCaller) {
    const doc = await this.prisma.document.findUnique({ where: { code } });
    if (!doc) throw new NotFoundException('Doklad nenalezen');
    return {
      bytes: await this.original(doc, caller),
      contentType: doc.contentType,
      filename: `${doc.code}-${doc.originalFilename}`,
      sha256: doc.sha256,
    };
  }

  /**
   * The unchanged bytes of a document's original, checked against its recorded hash. A
   * referenced supplier document comes through the core, which re-checks the caller's access
   * to its site on every read ("not found" otherwise).
   */
  async original(
    doc: Pick<DocumentRow, 'code' | 'source' | 'storageKey' | 'supplierDocumentId' | 'sha256'>,
    caller: FinanceCaller,
  ): Promise<Buffer> {
    const bytes =
      doc.source === 'SUPPLIER_DOCUMENT'
        ? await this.core.supplierDocumentContent(caller.sessionToken, doc.supplierDocumentId!)
        : await this.storage.get(doc.storageKey!);
    if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256)
      throw domainError(500, 'STORED_FILE_CHANGED', `Uložený originál ${doc.code} nesouhlasí.`);
    return bytes;
  }

  /** A metadata correction: the next version with a full snapshot and the reason. */
  async correct(
    code: string,
    input: CorrectFinanceDocumentRequest,
    caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    const current = await this.prisma.document.findUnique({ where: { code } });
    if (!current) throw new NotFoundException('Doklad nenalezen');
    // A new supplier must be active now (the core decides); an unchanged one keeps its name.
    const supplierName =
      input.supplierId && input.supplierId !== current.supplierId
        ? await this.activeSupplierName(caller, input.supplierId)
        : input.supplierId
          ? current.supplierName
          : null;
    await this.prisma.$transaction(async (tx) => {
      const doc = await lock(tx, code, input.expectedVersion);
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: {
          ...metadata(input),
          supplierName,
          version: doc.version + 1,
          updatedAt: new Date(),
        },
      });
      if (JSON.stringify(snapshotOf(updated)) === JSON.stringify(snapshotOf(doc)))
        throw domainError(422, 'NOTHING_CHANGED', 'Údaje se nezměnily.');
      await tx.documentEvent.create({
        data: {
          documentId: doc.id,
          version: updated.version,
          type: 'CORRECTED',
          snapshot: snapshotOf(updated),
          reason: input.reason,
          actorId: caller.principal.userId,
          actorName: caller.principal.displayName,
        },
      });
    });
    return this.detail(code);
  }

  /** Voids a document (it stays, with its file and history; it no longer counts). */
  async void(
    code: string,
    input: VoidFinanceDocumentRequest,
    caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    await this.prisma.$transaction(async (tx) => {
      const doc = await lock(tx, code, input.expectedVersion);
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: { status: 'VOIDED', version: doc.version + 1, updatedAt: new Date() },
      });
      await tx.documentEvent.create({
        data: {
          documentId: doc.id,
          version: updated.version,
          type: 'VOIDED',
          snapshot: snapshotOf(updated),
          reason: input.reason,
          actorId: caller.principal.userId,
          actorName: caller.principal.displayName,
        },
      });
    });
    return this.detail(code);
  }

  /**
   * The supplier exists and is active now (the core decides). Check-then-write: an archive in
   * between is accepted (ADR 0039 §4 — archiving concerns new receipts, not paperwork).
   */
  private async activeSupplierName(caller: FinanceCaller, id: string): Promise<string> {
    const supplier = (await this.core.lookupSuppliers(caller.sessionToken, [id])).get(id);
    if (!supplier || !supplier.active)
      throw domainError(422, 'SUPPLIER_INACTIVE', 'Dodavatel neexistuje nebo je archivovaný.');
    return supplier.name;
  }
}

async function assertNotReceived(tx: Prisma.TransactionClient, sha256: string) {
  const duplicate = await tx.document.findFirst({
    where: { sha256, status: 'ACTIVE' },
    select: { code: true },
  });
  if (duplicate)
    throw domainError(
      409,
      'DUPLICATE_DOCUMENT',
      `Tento soubor už je přijatý jako ${duplicate.code}.`,
    );
}

async function insert(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.DocumentUncheckedCreateInput, 'serial' | 'code'>,
): Promise<string> {
  const serial = await allocateFinanceSerial(tx, 'finance_document');
  const code = `FD-${String(serial).padStart(6, '0')}`;
  const doc = await tx.document.create({ data: { ...data, serial, code } });
  await tx.documentEvent.create({
    data: {
      documentId: doc.id,
      version: 1,
      type: 'RECEIVED',
      snapshot: snapshotOf(doc),
      actorId: data.createdBy,
      actorName: data.createdByName,
    },
  });
  return code;
}

async function lock(tx: Prisma.TransactionClient, code: string, expectedVersion: number) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "finance"."documents" WHERE "code" = ${code} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('Doklad nenalezen');
  const doc = await tx.document.findUniqueOrThrow({ where: { id: rows[0]!.id } });
  if (doc.status === 'VOIDED')
    throw domainError(409, 'DOCUMENT_VOIDED', 'Zrušený doklad už nelze měnit.');
  if (doc.version !== expectedVersion)
    throw domainError(409, 'STALE_VERSION', 'Doklad mezitím změnil někdo jiný. Načtěte ho znovu.');
  return doc;
}

function metadata(f: UploadFinanceDocumentFields | CorrectFinanceDocumentRequest) {
  return {
    supplierId: f.supplierId ?? null,
    kind: f.kind,
    documentNumber: f.documentNumber ?? null,
    issuedOn: dateOrNull(f.issuedOn),
    taxPointOn: dateOrNull(f.taxPointOn),
    dueOn: dateOrNull(f.dueOn),
    totalAmount: f.totalAmount ?? null,
    currency: f.currency ?? null,
    description: f.description ?? null,
    handoverMonth: monthOrNull(f.handoverMonth),
  };
}

/** The original request as given (absent = null), so a replay compares like with like. */
function canonical(f: UploadFinanceDocumentFields) {
  return {
    supplierId: f.supplierId ?? null,
    kind: f.kind,
    documentNumber: f.documentNumber ?? null,
    issuedOn: f.issuedOn ?? null,
    taxPointOn: f.taxPointOn ?? null,
    dueOn: f.dueOn ?? null,
    totalAmount: f.totalAmount ?? null,
    currency: f.currency ?? null,
    description: f.description ?? null,
    handoverMonth: f.handoverMonth ?? null,
  };
}

/** A unique violation while inserting means the file or supplier document is already received. */
function duplicateOr(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    return domainError(409, 'DUPLICATE_DOCUMENT', 'Tento soubor nebo doklad už je přijatý.');
  return error;
}

function snapshotOf(d: DocumentRow): Snapshot {
  return {
    supplierId: d.supplierId,
    supplierName: d.supplierName,
    kind: d.kind,
    documentNumber: d.documentNumber,
    issuedOn: day(d.issuedOn),
    taxPointOn: day(d.taxPointOn),
    dueOn: day(d.dueOn),
    totalAmount: d.totalAmount === null ? null : d.totalAmount.toFixed(2),
    currency: d.currency,
    description: d.description,
    handoverMonth: month(d.handoverMonth),
    status: d.status,
  };
}

/** What a document still needs before the export (doc 039 §3). */
export function missingForExport(d: {
  supplierId: string | null;
  documentNumber: string | null;
  issuedOn: Date | null;
  handoverMonth: Date | null;
}): FinanceExportRequiredField[] {
  return FINANCE_EXPORT_REQUIRED.filter((k) => d[k] === null);
}

function toDto(d: DocumentRow): FinanceDocument {
  return {
    id: d.id,
    code: d.code,
    supplier: d.supplierId && d.supplierName ? { id: d.supplierId, name: d.supplierName } : null,
    kind: d.kind as FinanceDocumentKind,
    documentNumber: d.documentNumber,
    issuedOn: day(d.issuedOn),
    taxPointOn: day(d.taxPointOn),
    dueOn: day(d.dueOn),
    totalAmount: d.totalAmount === null ? null : d.totalAmount.toFixed(2),
    currency: d.currency,
    description: d.description,
    handoverMonth: month(d.handoverMonth),
    missing: missingForExport(d),
    status: d.status as FinanceDocumentStatus,
    version: d.version,
    source: d.source as FinanceDocumentSource,
    supplierDocument:
      d.supplierDocumentId && d.sourceSiteCode
        ? { id: d.supplierDocumentId, siteCode: d.sourceSiteCode }
        : null,
    originalFilename: d.originalFilename,
    contentType: d.contentType,
    byteSize: d.byteSize,
    sha256: d.sha256,
    createdAt: d.createdAt.toISOString(),
    createdBy: d.createdByName,
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
