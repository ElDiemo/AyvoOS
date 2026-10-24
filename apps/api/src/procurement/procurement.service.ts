import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CreateGoodsReceiptRequest,
  CreateReceiptCorrectionRequest,
  ReceiptLineCostRequest,
  CreateSupplierRequest,
  GoodsReceipt,
  GoodsReceiptListQuery,
  GoodsReceiptPage,
  LinkReceiptDocumentRequest,
  Supplier as SupplierDto,
  SupplierDocument as SupplierDocumentDto,
  UploadSupplierDocumentFields,
} from '@ayvo/types';
import { RECEIPT_DATE_MIN } from '@ayvo/types';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError } from '../common/domain-error.js';
import { assertUnitScale, formatQuantity, quantity } from '../common/quantity.js';
import { ADMIN_API } from '../common/routes.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type Supplier, type SupplierDocument } from '../generated/prisma/client.js';
import type { WarehouseContext } from '../inventory/warehouse-context.js';
import { InventoryService, type NewMovement } from '../inventory/inventory.service.js';
import { AuditService } from '../audit/audit.service.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';

const DOCUMENT_TYPES: { type: string; ext: string; magic: number[] }[] = [
  { type: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { type: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
];

const receiptInclude = {
  supplier: true,
  documents: { include: { document: true }, orderBy: { linkedAt: 'asc' as const } },
  lines: {
    orderBy: { lineNo: 'asc' as const },
    include: {
      item: { include: { baseUnit: true } },
      lot: true,
      corrections: { orderBy: { createdAt: 'asc' as const } },
      // The current price: the latest completion/correction (append-only).
      costs: { orderBy: [{ recordedAt: 'desc' as const }, { id: 'desc' as const }], take: 1 },
    },
  },
} satisfies Prisma.GoodsReceiptInclude;

/** Who records a receipt and whether they may record purchase prices (doc 021 §4). */
export interface ReceiptActor {
  userId: string;
  canWriteCosts: boolean;
}

const hasCost = (l: { unitPrice: unknown; currency: unknown; vatRate: unknown }) =>
  l.unitPrice !== null || l.currency !== null || l.vatRate !== null;
type ReceiptRecord = Prisma.GoodsReceiptGetPayload<{ include: typeof receiptInclude }>;

/**
 * procurement module (doc 018): suppliers, supplier documents and goods receipts. A confirmed
 * receipt is the only way purchased goods enter stock; it is created confirmed and immutable,
 * with its lines, lots, document links and RECEIPT movements in one transaction.
 */
@Injectable()
export class ProcurementService {
  private readonly logger = new Logger(ProcurementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly inventory: InventoryService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly audit: AuditService,
  ) {}

  // --- suppliers -------------------------------------------------------------------------------

  async listSuppliers(includeArchived: boolean): Promise<SupplierDto[]> {
    const suppliers = await this.prisma.supplier.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { name: 'asc' },
    });
    return suppliers.map(toSupplierDto);
  }

  async createSupplier(input: CreateSupplierRequest): Promise<SupplierDto> {
    const { result } = await this.operations.run(
      'SUPPLIER_CREATE',
      input.requestId,
      input,
      async (tx) => {
        const clash = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM "suppliers" WHERE lower("name") = lower(${input.name})`;
        if (clash.length > 0) {
          throw domainError(409, 'SUPPLIER_EXISTS', 'A supplier with this name already exists');
        }
        const supplier = await tx.supplier.create({
          data: {
            name: input.name,
            companyId: input.companyId,
            vatId: input.vatId,
            requestId: input.requestId,
          },
        });
        return { supplierId: supplier.id };
      },
    );
    return toSupplierDto(await this.getSupplier(result.supplierId));
  }

  async archiveSupplier(id: string, requestId: string): Promise<SupplierDto> {
    await this.operations.run('SUPPLIER_ARCHIVE', requestId, { supplierId: id }, async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id } });
      if (!supplier) throw new NotFoundException('Supplier not found');
      if (!supplier.archivedAt)
        await tx.supplier.update({ where: { id }, data: { archivedAt: new Date() } });
      return { supplierId: id };
    });
    return toSupplierDto(await this.getSupplier(id));
  }

  private async getSupplier(id: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  /**
   * For other modules (finance): the supplier exists and is not archived, checked inside the
   * caller's transaction (row lock: an archive cannot slip in before its commit).
   */
  async assertActiveSupplier(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ archived_at: Date | null }[]>`
      SELECT "archived_at" FROM "suppliers" WHERE "id" = ${id}::uuid FOR SHARE`;
    if (rows.length === 0 || rows[0]!.archived_at !== null) {
      throw domainError(422, 'SUPPLIER_INACTIVE', 'The supplier does not exist or is archived');
    }
  }

  /** Name and registration ids of suppliers by id (for other modules' exports). */
  async supplierIdentities(
    ids: readonly string[],
  ): Promise<Map<string, { name: string; companyId: string | null; vatId: string | null }>> {
    const rows = await this.prisma.supplier.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true, companyId: true, vatId: true },
    });
    return new Map(
      rows.map((r) => [r.id, { name: r.name, companyId: r.companyId, vatId: r.vatId }]),
    );
  }

  /** Names of suppliers by id (for read models of other modules). */
  async supplierNames(ids: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.supplier.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // --- supplier documents ----------------------------------------------------------------------

  /** Stores an uploaded PDF/JPEG/PNG under a server-generated key, then records it. */
  async uploadDocument(
    fields: UploadSupplierDocumentFields,
    file: { buffer: Buffer; originalname: string },
    siteId: string,
  ): Promise<SupplierDocumentDto> {
    const format = DOCUMENT_TYPES.find((t) => t.magic.every((b, i) => file.buffer[i] === b));
    if (!format) {
      throw domainError(422, 'UNSUPPORTED_DOCUMENT', 'Upload a PDF, JPEG or PNG document');
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const { result } = await this.operations.run(
      'SUPPLIER_DOCUMENT_UPLOAD',
      fields.requestId,
      { ...fields, sha256, siteId },
      async (tx) => {
        const supplier = await tx.supplier.findUnique({ where: { id: fields.supplierId } });
        if (!supplier || supplier.archivedAt) {
          throw domainError(422, 'SUPPLIER_INACTIVE', 'The supplier does not exist or is archived');
        }
        if (fields.supersedesId) {
          const old = await tx.supplierDocument.findUnique({ where: { id: fields.supersedesId } });
          if (!old || old.supplierId !== fields.supplierId || old.siteId !== siteId) {
            throw domainError(
              422,
              'INVALID_SUPERSEDES',
              'Only a document of the same supplier can be superseded',
            );
          }
        }
        // File first, then the record: a failure in between leaves an unreferenced file
        // (logged), never a record without its file (ADR 0016).
        const storageKey = newStorageKey('supplier-documents', format.ext);
        await this.storage.put(storageKey, file.buffer);
        try {
          const document = await tx.supplierDocument.create({
            data: {
              supplierId: fields.supplierId,
              kind: fields.kind,
              documentNumber: fields.documentNumber,
              issuedOn: new Date(`${fields.issuedOn}T00:00:00Z`),
              storageKey,
              sha256,
              byteSize: file.buffer.length,
              contentType: format.type,
              originalFilename: safeFilename(file.originalname, format.ext),
              supersedesId: fields.supersedesId ?? null,
              requestId: fields.requestId,
              siteId,
            },
          });
          return { documentId: document.id };
        } catch (error) {
          this.logger.warn(
            `Unreferenced supplier document file after failed insert: ${storageKey}`,
          );
          throw error;
        }
      },
    );
    return toDocumentDto(await this.getDocumentRecord(result.documentId, siteId));
  }

  /** The supplier's documents received at the given site (paperwork belongs to its site). */
  async listDocuments(supplierId: string, siteId: string): Promise<SupplierDocumentDto[]> {
    const docs = await this.prisma.supplierDocument.findMany({
      where: { supplierId, siteId },
      orderBy: { createdAt: 'desc' },
    });
    return docs.map(toDocumentDto);
  }

  /** A document of the given site; another site's document is "not found" (no IDOR). */
  private async getDocumentRecord(id: string, siteId: string): Promise<SupplierDocument> {
    const doc = await this.prisma.supplierDocument.findUnique({ where: { id } });
    if (!doc || doc.siteId !== siteId) throw new NotFoundException('Supplier document not found');
    return doc;
  }

  async getDocumentContent(id: string, siteId: string) {
    const doc = await this.getDocumentRecord(id, siteId);
    return {
      bytes: await this.storage.get(doc.storageKey),
      contentType: doc.contentType,
      filename: doc.originalFilename,
    };
  }

  // --- goods receipts --------------------------------------------------------------------------

  /** Receives goods into the warehouse of the request's site (doc 022). */
  async createReceipt(
    input: CreateGoodsReceiptRequest,
    warehouse: WarehouseContext,
    actor: ReceiptActor,
  ): Promise<GoodsReceipt> {
    // Purchase prices are recorded only with procurement:cost_write — checked before anything
    // else (also for retries and idempotent replays); a hidden form field authorizes nothing.
    if (!actor.canWriteCosts && input.lines.some(hasCost)) {
      throw domainError(
        403,
        'COST_WRITE_REQUIRED',
        'Recording purchase prices needs the procurement:cost_write permission',
      );
    }
    const { result } = await this.operations.run(
      'GOODS_RECEIPT',
      input.requestId,
      { ...input, siteId: warehouse.siteId },
      async (tx) => {
        const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
        if (!supplier || supplier.archivedAt) {
          throw domainError(422, 'SUPPLIER_INACTIVE', 'The supplier does not exist or is archived');
        }
        const documentIds = [...new Set(input.documentIds)];
        const documents = await tx.supplierDocument.findMany({
          where: { id: { in: documentIds } },
        });
        if (
          documents.length !== documentIds.length ||
          documents.some((d) => d.supplierId !== supplier.id || d.siteId !== warehouse.siteId)
        ) {
          throw domainError(
            422,
            'INVALID_DOCUMENT',
            'Every document must exist and belong to this supplier',
          );
        }
        if (!documents.some((d) => d.kind === 'INVOICE' || d.kind === 'DELIVERY_NOTE')) {
          throw domainError(
            422,
            'DOCUMENT_REQUIRED',
            'Attach an invoice or a delivery note to confirm the receipt',
          );
        }
        const receivedAt = new Date(input.receivedAt);
        if (
          receivedAt.getTime() > Date.now() + 10 * 60_000 ||
          receivedAt.getTime() < Date.parse(RECEIPT_DATE_MIN)
        ) {
          throw domainError(
            422,
            'INVALID_DATE',
            'The receipt date must be between 2020-01-01 and now',
          );
        }

        const items = await this.inventory.getItemsByIds(
          input.lines.map((l) => l.itemId),
          tx,
        );
        const itemById = new Map(items.map((i) => [i.id, i]));
        const serial = (await allocateSerials(tx, 'goods_receipt', 1)).first;
        const code = formatCode(CODE_PREFIX.goodsReceipt, serial);
        const location = { id: warehouse.locationId };

        const receipt = await tx.goodsReceipt.create({
          data: {
            serial,
            code,
            siteId: warehouse.siteId,
            actorId: actor.userId,
            type: 'PURCHASE',
            supplierId: supplier.id,
            supplierReference: input.supplierReference,
            receivedAt,
            note: input.note,
            requestId: input.requestId,
          },
        });

        const movements: NewMovement[] = [];
        for (const [index, line] of input.lines.entries()) {
          const lineNo = index + 1;
          const item = itemById.get(line.itemId);
          if (!item || item.archivedAt) {
            throw domainError(422, 'INVALID_ITEM', `Line ${lineNo}: unknown or archived item`);
          }
          const qty = quantity(line.quantity);
          assertUnitScale(qty, item.baseUnit.decimalPlaces, `Line ${lineNo} quantity`);
          if ((line.unitPrice === null) !== (line.currency === null)) {
            throw domainError(
              422,
              'INVALID_PRICE',
              `Line ${lineNo}: give the unit price together with its currency`,
            );
          }
          const lineId = randomUUID();
          let lotId: string | null = null;
          if (item.lotTracking === 'REQUIRED') {
            lotId = line.supplierLotCode
              ? await this.inventory.findOrCreateSupplierLot(
                  tx,
                  item.id,
                  supplier.id,
                  line.supplierLotCode,
                )
              : await this.inventory.createInternalLot(tx, item.id, `${code}/${lineNo}`, lineId);
          } else if (line.supplierLotCode) {
            throw domainError(
              422,
              'LOT_NOT_TRACKED',
              `Line ${lineNo}: ${item.code} is not lot-tracked`,
            );
          }
          await tx.goodsReceiptLine.create({
            data: {
              id: lineId,
              receiptId: receipt.id,
              lineNo,
              itemId: item.id,
              unitId: item.baseUnitId,
              quantity: qty,
              lotId,
              unitPrice: line.unitPrice === null ? null : quantity(line.unitPrice),
              currency: line.currency,
              vatRate: line.vatRate === null ? null : quantity(line.vatRate),
            },
          });
          movements.push({
            itemId: item.id,
            unitId: item.baseUnitId,
            locationId: location.id,
            lotId,
            quantityDelta: qty,
            type: 'RECEIPT',
            receiptLineId: lineId,
            occurredAt: receivedAt,
            requestId: input.requestId,
          });
        }
        await tx.goodsReceiptDocument.createMany({
          data: documentIds.map((documentId) => ({
            receiptId: receipt.id,
            documentId,
            requestId: input.requestId,
          })),
        });
        await this.inventory.postMovements(tx, movements);
        const priced = input.lines
          .map((l, i) => ({ lineNo: i + 1, ...l }))
          .filter(hasCost)
          .map((l) => ({
            lineNo: l.lineNo,
            unitPrice: l.unitPrice,
            currency: l.currency,
            vatRate: l.vatRate,
          }));
        if (priced.length > 0) {
          await this.audit.record(
            {
              type: 'RECEIPT_COSTS_RECORDED',
              actorUserId: actor.userId,
              siteId: warehouse.siteId,
              reason: `Prices recorded with goods receipt ${code}`,
              payload: { receipt: code, lines: priced },
            },
            tx,
          );
        }
        return { receiptCode: code };
      },
    );
    // A replay from another site finds no receipt there (404) — nothing crosses sites.
    return this.getReceipt(result.receiptCode, warehouse.siteId);
  }

  async listReceipts(query: GoodsReceiptListQuery, siteId: string): Promise<GoodsReceiptPage> {
    const where: Prisma.GoodsReceiptWhereInput = {
      siteId,
      ...(query.invoice === 'pending'
        ? { documents: { none: { document: { kind: 'INVOICE' } } } }
        : {}),
    };
    const [total, receipts] = await this.prisma.$transaction([
      this.prisma.goodsReceipt.count({ where }),
      this.prisma.goodsReceipt.findMany({
        where,
        orderBy: { serial: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          supplier: true,
          _count: { select: { lines: true } },
          documents: { include: { document: { select: { kind: true } } } },
        },
      }),
    ]);
    return {
      items: receipts.map((r) => ({
        code: r.code,
        supplier: { id: r.supplier.id, name: r.supplier.name },
        supplierReference: r.supplierReference,
        receivedAt: r.receivedAt.toISOString(),
        invoicePending: !r.documents.some((d) => d.document.kind === 'INVOICE'),
        lineCount: r._count.lines,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** A receipt of the given site; a receipt of another site is "not found" (doc 022). */
  async getReceipt(code: string, siteId: string): Promise<GoodsReceipt> {
    return toReceiptDto(await this.findReceipt(code, siteId, this.prisma));
  }

  private async findReceipt(
    code: string,
    siteId: string,
    db: Prisma.TransactionClient,
  ): Promise<ReceiptRecord> {
    const serial = parseCodeSerial(CODE_PREFIX.goodsReceipt, code);
    const receipt =
      serial === null
        ? null
        : await db.goodsReceipt.findUnique({ where: { serial }, include: receiptInclude });
    if (!receipt || receipt.siteId !== siteId)
      throw new NotFoundException('Goods receipt not found');
    return receipt;
  }

  /** Adds a document to a confirmed receipt (e.g. the invoice arriving after the goods). */
  async linkDocument(
    code: string,
    input: LinkReceiptDocumentRequest,
    siteId: string,
  ): Promise<GoodsReceipt> {
    await this.operations.run(
      'RECEIPT_DOCUMENT_LINK',
      input.requestId,
      { code, ...input, siteId },
      async (tx) => {
        const receipt = await this.findReceipt(code, siteId, tx);
        const document = await tx.supplierDocument.findUnique({ where: { id: input.documentId } });
        if (
          !document ||
          document.supplierId !== receipt.supplierId ||
          document.siteId !== receipt.siteId
        ) {
          throw domainError(
            422,
            'INVALID_DOCUMENT',
            'The document must belong to the receipt supplier',
          );
        }
        if (receipt.documents.some((d) => d.documentId === input.documentId)) {
          throw domainError(
            409,
            'DOCUMENT_ALREADY_LINKED',
            'This document is already linked to the receipt',
          );
        }
        await tx.goodsReceiptDocument.create({
          data: { receiptId: receipt.id, documentId: input.documentId, requestId: input.requestId },
        });
        return { receiptCode: receipt.code };
      },
    );
    return this.getReceipt(code, siteId);
  }

  /**
   * Completes or corrects the purchase price of one receipt line (FINANCE,
   * `procurement:cost_write`; doc 021 §4). Append-only: the receipt line keeps what was recorded
   * at receipt; the latest record is the current price. Reason required; audited with the site.
   */
  async recordLineCost(
    code: string,
    lineNo: number,
    input: ReceiptLineCostRequest,
    siteId: string,
    actorId: string,
  ): Promise<GoodsReceipt> {
    await this.operations.run(
      'RECEIPT_LINE_COST',
      input.requestId,
      { code, lineNo, ...input, siteId },
      async (tx) => {
        const receipt = await this.findReceipt(code, siteId, tx);
        const line = receipt.lines.find((l) => l.lineNo === lineNo);
        if (!line) throw domainError(422, 'INVALID_LINE', `The receipt has no line ${lineNo}`);
        const previous = line.costs[0] ?? line;
        await tx.goodsReceiptLineCost.create({
          data: {
            receiptLineId: line.id,
            unitPrice: input.unitPrice === null ? null : quantity(input.unitPrice),
            currency: input.currency,
            vatRate: input.vatRate === null ? null : quantity(input.vatRate),
            reason: input.reason,
            actorId,
            siteId,
            requestId: input.requestId,
          },
        });
        await this.audit.record(
          {
            type: 'RECEIPT_COST_CORRECTED',
            actorUserId: actorId,
            siteId,
            reason: input.reason,
            payload: {
              receipt: receipt.code,
              lineNo,
              unitPrice: input.unitPrice,
              currency: input.currency,
              vatRate: input.vatRate,
              previous: {
                unitPrice: previous.unitPrice ? formatQuantity(previous.unitPrice) : null,
                currency: previous.currency,
                vatRate: previous.vatRate ? formatQuantity(previous.vatRate) : null,
              },
            },
          },
          tx,
        );
        return { receiptCode: receipt.code };
      },
    );
    return this.getReceipt(code, siteId);
  }

  /**
   * Compensating correction of one receipt line (warehouse-manager action, doc 018). Lock order:
   * request → receipt line → balance. Never below zero for the line or the stock.
   */
  async correctLine(
    code: string,
    input: CreateReceiptCorrectionRequest,
    siteId: string,
  ): Promise<GoodsReceipt> {
    await this.operations.run(
      'RECEIPT_CORRECTION',
      input.requestId,
      { code, ...input, siteId },
      async (tx) => {
        const receipt = await this.findReceipt(code, siteId, tx);
        const line = receipt.lines.find((l) => l.lineNo === input.lineNo);
        if (!line)
          throw domainError(422, 'INVALID_LINE', `The receipt has no line ${input.lineNo}`);
        await tx.$queryRaw`SELECT 1 FROM "goods_receipt_lines" WHERE "id" = ${line.id}::uuid FOR UPDATE`;
        const delta = quantity(input.quantityDelta);
        assertUnitScale(delta, line.item.baseUnit.decimalPlaces, 'Correction quantity');
        const corrected = await tx.goodsReceiptCorrection.aggregate({
          where: { receiptLineId: line.id },
          _sum: { quantityDelta: true },
        });
        const net = line.quantity.plus(corrected._sum.quantityDelta ?? 0);
        if (net.plus(delta).isNegative()) {
          throw domainError(
            422,
            'CORRECTION_BELOW_ZERO',
            'The correction would make the receipt line negative',
          );
        }
        // The correction acts where the goods were received.
        const received = await tx.inventoryMovement.findFirst({
          where: { receiptLineId: line.id },
          select: { locationId: true },
        });
        if (!received) throw new Error('Receipt line without its receipt movement');
        const location = { id: received.locationId };
        if (delta.isNegative()) {
          const onHand = await this.inventory.lockBalance(tx, {
            itemId: line.itemId,
            locationId: location.id,
            lotId: line.lotId,
          });
          if (onHand.plus(delta).isNegative()) {
            throw domainError(
              409,
              'INSUFFICIENT_STOCK',
              'Not enough stock left to remove this quantity',
            );
          }
        }
        const correction = await tx.goodsReceiptCorrection.create({
          data: {
            receiptLineId: line.id,
            quantityDelta: delta,
            reason: input.reason,
            occurredAt: new Date(),
            requestId: input.requestId,
          },
        });
        await this.inventory.postMovements(tx, [
          {
            itemId: line.itemId,
            unitId: line.unitId,
            locationId: location.id,
            lotId: line.lotId,
            quantityDelta: delta,
            type: 'RECEIPT_CORRECTION',
            receiptCorrectionId: correction.id,
            occurredAt: correction.occurredAt,
            requestId: input.requestId,
          },
        ]);
        return { receiptCode: receipt.code };
      },
    );
    return this.getReceipt(code, siteId);
  }

  // --- read helpers for other modules ----------------------------------------------------------

  /** Receipt code + line number of receipt lines, and reasons of corrections (ledger view). */
  async describeSources(lineIds: readonly string[], correctionIds: readonly string[]) {
    const [lines, corrections] = await Promise.all([
      this.prisma.goodsReceiptLine.findMany({
        where: { id: { in: [...lineIds] } },
        select: { id: true, lineNo: true, receipt: { select: { code: true } } },
      }),
      this.prisma.goodsReceiptCorrection.findMany({
        where: { id: { in: [...correctionIds] } },
        select: {
          id: true,
          reason: true,
          receiptLine: { select: { lineNo: true, receipt: { select: { code: true } } } },
        },
      }),
    ]);
    return {
      lines: new Map(lines.map((l) => [l.id, { receiptCode: l.receipt.code, lineNo: l.lineNo }])),
      corrections: new Map(
        corrections.map((c) => [
          c.id,
          {
            receiptCode: c.receiptLine.receipt.code,
            lineNo: c.receiptLine.lineNo,
            reason: c.reason,
          },
        ]),
      ),
    };
  }

  /** The first receipt line that brought each lot in (traceability of a lot to its receipt). */
  async firstReceiptLineOfLots(lotIds: readonly string[]) {
    const lines = await this.prisma.goodsReceiptLine.findMany({
      where: { lotId: { in: [...lotIds] } },
      orderBy: { receipt: { serial: 'asc' } },
      select: {
        lotId: true,
        lineNo: true,
        receipt: { select: { code: true, supplier: { select: { id: true, name: true } } } },
      },
    });
    const first = new Map<string, (typeof lines)[number]>();
    for (const line of lines) if (line.lotId && !first.has(line.lotId)) first.set(line.lotId, line);
    return first;
  }
}

function safeFilename(name: string, ext: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : `document.${ext}`;
}

function toSupplierDto(s: Supplier): SupplierDto {
  return {
    id: s.id,
    name: s.name,
    companyId: s.companyId,
    vatId: s.vatId,
    createdAt: s.createdAt.toISOString(),
    archivedAt: s.archivedAt?.toISOString() ?? null,
  };
}

function toDocumentDto(d: SupplierDocument): SupplierDocumentDto {
  return {
    id: d.id,
    supplierId: d.supplierId,
    kind: d.kind,
    documentNumber: d.documentNumber,
    issuedOn: d.issuedOn.toISOString().slice(0, 10),
    originalFilename: d.originalFilename,
    contentType: d.contentType,
    byteSize: d.byteSize,
    supersedesId: d.supersedesId,
    createdAt: d.createdAt.toISOString(),
    contentUrl: `${ADMIN_API}/supplier-documents/${d.id}/content`,
  };
}

function toReceiptDto(r: ReceiptRecord): GoodsReceipt {
  return {
    code: r.code,
    type: r.type,
    supplier: { id: r.supplier.id, name: r.supplier.name },
    supplierReference: r.supplierReference,
    receivedAt: r.receivedAt.toISOString(),
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    invoicePending: !r.documents.some((d) => d.document.kind === 'INVOICE'),
    documents: r.documents.map((d) => ({
      ...toDocumentDto(d.document),
      linkedAt: d.linkedAt.toISOString(),
    })),
    lines: r.lines.map((l) => {
      const net = l.corrections.reduce((sum, c) => sum.plus(c.quantityDelta), quantity(l.quantity));
      return {
        lineNo: l.lineNo,
        item: {
          id: l.item.id,
          code: l.item.code,
          name: l.item.name,
          unitCode: l.item.baseUnit.code,
        },
        quantity: formatQuantity(l.quantity),
        netQuantity: formatQuantity(net),
        lot: l.lot ? { id: l.lot.id, code: l.lot.code, kind: l.lot.kind } : null,
        ...currentCost(l),
        corrections: l.corrections.map((c) => ({
          id: c.id,
          quantityDelta: formatQuantity(c.quantityDelta),
          reason: c.reason,
          occurredAt: c.occurredAt.toISOString(),
          createdAt: c.createdAt.toISOString(),
        })),
      };
    }),
  };
}

/** The current price of a line: its latest completion/correction, else what was received. */
function currentCost(line: ReceiptRecord['lines'][number]) {
  const latest = line.costs[0];
  const source = latest ?? line;
  return {
    unitPrice: source.unitPrice ? formatQuantity(source.unitPrice) : null,
    currency: source.currency,
    vatRate: source.vatRate ? formatQuantity(source.vatRate) : null,
    costUpdatedAt: latest ? latest.recordedAt.toISOString() : null,
  };
}
