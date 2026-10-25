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
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { ProcurementService } from '../procurement/procurement.service.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';

/** Finance's own uploads are PDF only (doc 039 §3), recognised by content, never by name/type. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** A supplier document of Sklad may be read by whoever reads its site's paperwork (doc 021). */
export function canReadSupplierDocuments(principal: Principal, siteId: string): boolean {
  return (
    principal.permissions.has('procurement:documents_read') &&
    (principal.globalSiteAccess || principal.sites.some((s) => s.id === siteId))
  );
}

/** Kinds of supplier documents as finance kinds (the user may correct it afterwards). */
const TAKEOVER_KIND: Record<string, FinanceDocumentKind> = {
  INVOICE: 'INVOICE',
  DELIVERY_NOTE: 'OTHER',
  OTHER_APPROVED: 'OTHER',
};

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
  'handoverMonth',
  'status',
] as const;
type Snapshot = Record<(typeof SNAPSHOT_FIELDS)[number], string | null>;

const include = {
  supplier: { select: { id: true, name: true } },
  sourceSite: { select: { code: true } },
  creator: { select: { displayName: true } },
} satisfies Prisma.FinanceDocumentInclude;
type DocumentRecord = Prisma.FinanceDocumentGetPayload<{ include: typeof include }>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const month = (d: Date | null) => (d ? d.toISOString().slice(0, 7) : null);
const dateOrNull = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
const monthOrNull = (s: string | null | undefined) => (s ? new Date(`${s}-01T00:00:00Z`) : null);

/**
 * Finance — received documents (doc 039, N1). Owns finance_documents and their events; reads
 * suppliers and supplier documents only through ProcurementService. An original is either
 * Finance's own PDF (stored once, never changed) or a referenced supplier document (no copy).
 * Metadata may be incomplete ("k doplnění") and changes only through a new version with its
 * event; nothing is deleted. Writes are idempotent per request id (operation_requests).
 */
@Injectable()
export class FinanceDocumentsService {
  private readonly logger = new Logger(FinanceDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly procurement: ProcurementService,
    private readonly operations: OperationRequestsService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async suppliers(): Promise<FinanceSupplier[]> {
    return (await this.procurement.listSuppliers(false)).map((s) => ({ id: s.id, name: s.name }));
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
    actorId: string,
  ): Promise<FinanceDocumentDetail> {
    if (!PDF_MAGIC.every((b, i) => file.buffer[i] === b))
      throw domainError(422, 'UNSUPPORTED_DOCUMENT', 'Nahrajte originál dokladu jako PDF.');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const metadata = this.metadata(fields);
    const { result } = await this.operations.run(
      'FINANCE_DOCUMENT_RECEIVE',
      fields.requestId,
      { ...this.canonical(fields), sha256, actorId },
      async (tx) => {
        await this.assertNotReceived(tx, sha256);
        if (metadata.supplierId) await this.procurement.assertActiveSupplier(tx, metadata.supplierId);
        // File first, then the record: a failure in between leaves an unreferenced file
        // (logged), never a record without its file (ADR 0016).
        const storageKey = newStorageKey('finance-documents', 'pdf');
        await this.storage.put(storageKey, file.buffer);
        try {
          return {
            code: await this.insert(tx, {
              ...metadata,
              source: 'UPLOAD',
              storageKey,
              sha256,
              byteSize: file.buffer.length,
              contentType: 'application/pdf',
              originalFilename: safeFilename(file.originalname, 'pdf'),
              createdBy: actorId,
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
   * Supplier documents of Sklad the user may take over: only sites whose paperwork they may read
   * (procurement:documents_read there), marked when superseded or already taken over.
   */
  async takeOverCandidates(principal: Principal, supplierId?: string): Promise<TakeOverCandidate[]> {
    if (!principal.permissions.has('procurement:documents_read')) return [];
    const docs = await this.procurement.supplierDocumentsOfSites(
      principal.globalSiteAccess ? null : principal.sites.map((s) => s.id),
      supplierId,
    );
    const taken = await this.prisma.financeDocument.findMany({
      where: { supplierDocumentId: { in: docs.map((d) => d.id) }, status: 'ACTIVE' },
      select: { code: true, supplierDocumentId: true },
    });
    const by = new Map(taken.map((t) => [t.supplierDocumentId, t.code]));
    return docs.map(({ siteId: _site, ...d }) => ({ ...d, takenOverBy: by.get(d.id) ?? null }));
  }

  /**
   * Takes over an existing supplier document: one finance document referencing it — no second
   * copy of the file, no receipt, stock movement or price. Access to its site's paperwork is
   * checked now and on every replay; another site's document is "not found". One valid finance
   * document per supplier document (DB).
   */
  async takeOver(
    input: TakeOverSupplierDocumentRequest,
    principal: Principal,
  ): Promise<FinanceDocumentDetail> {
    const visible = await this.procurement.supplierDocumentForTakeover(
      this.prisma,
      input.supplierDocumentId,
    );
    if (!visible || !canReadSupplierDocuments(principal, visible.siteId))
      throw new NotFoundException('Doklad skladu nenalezen');
    const { result } = await this.operations.run(
      'FINANCE_DOCUMENT_TAKEOVER',
      input.requestId,
      {
        supplierDocumentId: input.supplierDocumentId,
        kind: input.kind ?? null,
        handoverMonth: input.handoverMonth ?? null,
        description: input.description ?? null,
        actorId: principal.userId,
      },
      async (tx) => {
        const src = await this.procurement.supplierDocumentForTakeover(tx, input.supplierDocumentId);
        if (!src) throw new NotFoundException('Doklad skladu nenalezen');
        const taken = await tx.financeDocument.findFirst({
          where: { supplierDocumentId: src.id, status: 'ACTIVE' },
          select: { code: true },
        });
        if (taken)
          throw domainError(
            409,
            'ALREADY_TAKEN_OVER',
            `Tento doklad skladu už je ve Financích jako ${taken.code}.`,
          );
        await this.assertNotReceived(tx, src.sha256);
        try {
          return {
            code: await this.insert(tx, {
              supplierId: src.supplierId,
              kind: input.kind ?? TAKEOVER_KIND[src.kind] ?? 'OTHER',
              documentNumber: src.documentNumber,
              issuedOn: src.issuedOn,
              taxPointOn: null,
              dueOn: null,
              totalAmount: null,
              currency: null,
              description: input.description ?? null,
              handoverMonth: monthOrNull(input.handoverMonth),
              source: 'SUPPLIER_DOCUMENT',
              supplierDocumentId: src.id,
              sourceSiteId: src.siteId,
              storageKey: null,
              sha256: src.sha256,
              byteSize: src.byteSize,
              contentType: src.contentType,
              originalFilename: src.originalFilename,
              createdBy: principal.userId,
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

  private async assertNotReceived(tx: Prisma.TransactionClient, sha256: string) {
    const duplicate = await tx.financeDocument.findFirst({
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

  private async insert(
    tx: Prisma.TransactionClient,
    data: Omit<Prisma.FinanceDocumentUncheckedCreateInput, 'serial' | 'code'>,
  ): Promise<string> {
    const { first } = await allocateSerials(tx, 'finance_document', 1);
    const code = `FD-${String(first).padStart(6, '0')}`;
    const doc = await tx.financeDocument.create({ data: { ...data, serial: first, code } });
    await tx.financeDocumentEvent.create({
      data: {
        documentId: doc.id,
        version: 1,
        type: 'RECEIVED',
        snapshot: snapshotOf(doc),
        actorId: data.createdBy,
      },
    });
    return code;
  }

  async list(query: FinanceDocumentListQuery): Promise<FinanceDocumentPage> {
    const q = query.q?.trim();
    const where: Prisma.FinanceDocumentWhereInput = {
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
              { supplier: { name: { contains: q, mode: 'insensitive' } } },
              ],
            },
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.financeDocument.count({ where }),
      this.prisma.financeDocument.findMany({
        where,
        include,
        orderBy: { serial: 'desc' },
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
        events: {
          orderBy: { version: 'asc' },
          include: { actor: { select: { displayName: true } } },
        },
      },
    });
    if (!doc) throw new NotFoundException('Doklad nenalezen');
    // A supplier change is shown by name (the snapshot keeps the id).
    const supplierIds = doc.events.map((e) => (e.snapshot as Record<string, unknown>).supplierId);
    const names = await this.procurement.supplierNames(
      supplierIds.filter((v): v is string => typeof v === 'string'),
    );
    let before: Record<string, unknown> | null = null;
    const history: FinanceDocumentEvent[] = doc.events.map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      const changes: Record<string, [unknown, unknown]> = {};
      if (before)
        for (const k of SNAPSHOT_FIELDS)
          if (before[k] !== snap[k])
            changes[k] =
              k === 'supplierId'
                ? [names.get(String(before[k])) ?? before[k], names.get(String(snap[k])) ?? snap[k]]
                : [before[k], snap[k]];
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
  async content(code: string, principal: Principal) {
    const doc = await this.prisma.financeDocument.findUnique({ where: { code } });
    if (!doc) throw new NotFoundException('Doklad nenalezen');
    return {
      bytes: await this.original(doc, principal),
      contentType: doc.contentType,
      filename: `${doc.code}-${doc.originalFilename}`,
      sha256: doc.sha256,
    };
  }

  /**
   * The unchanged bytes of a document's original, checked against its recorded hash. A
   * referenced supplier document needs read access to its site's paperwork (checked again on
   * every read); otherwise it is "not found".
   */
  async original(
    doc: Pick<
      DocumentRow,
      'code' | 'source' | 'storageKey' | 'supplierDocumentId' | 'sourceSiteId' | 'sha256'
    >,
    principal: Principal,
  ): Promise<Buffer> {
    let bytes: Buffer;
    if (doc.source === 'SUPPLIER_DOCUMENT') {
      if (!canReadSupplierDocuments(principal, doc.sourceSiteId!))
        throw new NotFoundException('Doklad nenalezen');
      bytes = await this.procurement.supplierDocumentBytes(doc.supplierDocumentId!);
    } else bytes = await this.storage.get(doc.storageKey!);
    if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256)
      throw domainError(500, 'STORED_FILE_CHANGED', `Uložený originál ${doc.code} nesouhlasí.`);
    return bytes;
  }

  /** A metadata correction: the next version with a full snapshot and the reason. */
  async correct(
    code: string,
    input: CorrectFinanceDocumentRequest,
    actorId: string,
  ): Promise<FinanceDocumentDetail> {
    await this.prisma.$transaction(async (tx) => {
      const doc = await this.lock(tx, code, input.expectedVersion);
      if (input.supplierId && input.supplierId !== doc.supplierId)
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
      throw domainError(
        409,
        'STALE_VERSION',
        'Doklad mezitím změnil někdo jiný. Načtěte ho znovu.',
      );
    return doc;
  }

  private metadata(f: UploadFinanceDocumentFields | CorrectFinanceDocumentRequest) {
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
  private canonical(f: UploadFinanceDocumentFields) {
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
}

/** A unique violation while inserting means the file or supplier document is already received. */
function duplicateOr(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    return domainError(409, 'DUPLICATE_DOCUMENT', 'Tento soubor nebo doklad už je přijatý.');
  return error;
}

type DocumentRow = Prisma.FinanceDocumentGetPayload<object>;

function snapshotOf(d: {
  supplierId: string | null;
  kind: string;
  documentNumber: string | null;
  issuedOn: Date | null;
  taxPointOn: Date | null;
  dueOn: Date | null;
  totalAmount: Prisma.Decimal | null;
  currency: string | null;
  description: string | null;
  handoverMonth: Date | null;
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

function toDto(d: DocumentRecord): FinanceDocument {
  return {
    id: d.id,
    code: d.code,
    supplier: d.supplier,
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
      d.supplierDocumentId && d.sourceSite
        ? { id: d.supplierDocumentId, siteCode: d.sourceSite.code }
        : null,
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
