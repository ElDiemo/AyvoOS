import {
  archiveSupplierRequestSchema,
  createGoodsReceiptRequestSchema,
  createReceiptCorrectionRequestSchema,
  createSupplierRequestSchema,
  goodsReceiptCodeSchema,
  goodsReceiptListQuerySchema,
  linkReceiptDocumentRequestSchema,
  receiptLineCostRequestSchema,
  type ReceiptLineCostRequest,
  uploadSupplierDocumentFieldsSchema,
  type CreateGoodsReceiptRequest,
  type CreateReceiptCorrectionRequest,
  type CreateSupplierRequest,
  type GoodsReceipt,
  type GoodsReceiptListQuery,
  type GoodsReceiptPage,
  type LinkReceiptDocumentRequest,
  type Supplier,
  type SupplierDocument,
  type UploadSupplierDocumentFields,
} from '@ayvo/types';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProcurementService } from './procurement.service.js';
import { RequirePermission } from '../identity/access.decorators.js';
import {
  CurrentPrincipal,
  OperationalSite,
  OperationalWarehouse,
} from '../identity/access.guard.js';
import type { SiteContext, WarehouseContext } from '../inventory/warehouse-context.js';
import type { Principal } from '../identity/principal.js';
import { receiptForViewer } from './receipt-visibility.js';

const RECEIPT_CODE = new ZodValidationPipe(goodsReceiptCodeSchema);
const supplierListQuerySchema = z.object({ archived: z.enum(['true', 'false']).default('false') });

/**
 * Admin API: suppliers, supplier documents, goods receipts (doc 018). Supplier master data is
 * company-wide; documents, receipts and prices belong to the receiving site and are read only at
 * the active site. Documents need procurement:documents_read; receipt responses omit prices
 * without procurement:cost_read and linked documents without procurement:documents_read
 * (receiptForViewer); recording prices needs procurement:cost_write (doc 021 §4).
 */
@Controller(ADMIN_PREFIX)
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @RequirePermission('inventory:read')
  @Get('suppliers')
  suppliers(
    @Query(new ZodValidationPipe(supplierListQuerySchema))
    q: z.infer<typeof supplierListQuerySchema>,
  ): Promise<Supplier[]> {
    return this.procurement.listSuppliers(q.archived === 'true');
  }

  @RequirePermission('procurement:suppliers_manage')
  @Post('suppliers')
  createSupplier(
    @Body(new ZodValidationPipe(createSupplierRequestSchema)) body: CreateSupplierRequest,
  ): Promise<Supplier> {
    return this.procurement.createSupplier(body);
  }

  @RequirePermission('procurement:suppliers_manage')
  @Post('suppliers/:id/archive')
  @HttpCode(200)
  archiveSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(archiveSupplierRequestSchema)) body: { requestId: string },
  ): Promise<Supplier> {
    return this.procurement.archiveSupplier(id, body.requestId);
  }

  @RequirePermission('procurement:documents_read')
  @Get('suppliers/:id/documents')
  documents(
    @Param('id', ParseUUIDPipe) id: string,
    @OperationalSite() site: SiteContext,
  ): Promise<SupplierDocument[]> {
    return this.procurement.listDocuments(id, site.siteId);
  }

  /** multipart/form-data: fields of uploadSupplierDocumentFieldsSchema + one `file` (PDF/JPEG/PNG). */
  @RequirePermission('inventory:receive')
  @Post('supplier-documents')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Body(new ZodValidationPipe(uploadSupplierDocumentFieldsSchema))
    fields: UploadSupplierDocumentFields,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<SupplierDocument> {
    if (!file) throw new BadRequestException('Attach the document as the "file" field');
    return this.procurement.uploadDocument(fields, file, warehouse.siteId);
  }

  @RequirePermission('procurement:documents_read')
  @Get('supplier-documents/:id/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('X-Content-Type-Options', 'nosniff')
  async documentContent(
    @Param('id', ParseUUIDPipe) id: string,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    const { bytes, contentType, filename } = await this.procurement.getDocumentContent(
      id,
      site.siteId,
    );
    return new StreamableFile(bytes, {
      type: contentType,
      disposition: `inline; filename="${filename.replace(/"/g, '')}"`,
    });
  }

  @RequirePermission('inventory:read')
  @Get('goods-receipts')
  receipts(
    @Query(new ZodValidationPipe(goodsReceiptListQuerySchema)) query: GoodsReceiptListQuery,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<GoodsReceiptPage> {
    return this.procurement.listReceipts(query, warehouse.siteId);
  }

  @RequirePermission('inventory:receive')
  @Post('goods-receipts')
  async createReceipt(
    @Body(new ZodValidationPipe(createGoodsReceiptRequestSchema)) body: CreateGoodsReceiptRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<GoodsReceipt> {
    return receiptForViewer(
      await this.procurement.createReceipt(body, warehouse, {
        userId: principal.userId,
        canWriteCosts: principal.permissions.has('procurement:cost_write'),
      }),
      principal.permissions,
    );
  }

  @RequirePermission('inventory:read')
  @Get('goods-receipts/:code')
  async receipt(
    @Param('code', RECEIPT_CODE) code: string,
    @CurrentPrincipal() principal: Principal,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<GoodsReceipt> {
    return receiptForViewer(
      await this.procurement.getReceipt(code, warehouse.siteId),
      principal.permissions,
    );
  }

  /** Append-only: adds a document (e.g. the invoice that arrived after the goods). */
  @RequirePermission('inventory:receive')
  @Post('goods-receipts/:code/documents')
  @HttpCode(200)
  async linkDocument(
    @Param('code', RECEIPT_CODE) code: string,
    @Body(new ZodValidationPipe(linkReceiptDocumentRequestSchema)) body: LinkReceiptDocumentRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<GoodsReceipt> {
    return receiptForViewer(
      await this.procurement.linkDocument(code, body, warehouse.siteId),
      principal.permissions,
    );
  }

  /** Completes or corrects a line's purchase price (FINANCE; reason required, audited). */
  @RequirePermission('inventory:read', 'procurement:cost_write')
  @Post('goods-receipts/:code/lines/:lineNo/cost')
  @HttpCode(200)
  async lineCost(
    @Param('code', RECEIPT_CODE) code: string,
    @Param('lineNo', new ZodValidationPipe(z.coerce.number().int().min(1).max(1000)))
    lineNo: number,
    @Body(new ZodValidationPipe(receiptLineCostRequestSchema)) body: ReceiptLineCostRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<GoodsReceipt> {
    return receiptForViewer(
      await this.procurement.recordLineCost(code, lineNo, body, warehouse.siteId, principal.userId),
      principal.permissions,
    );
  }

  /** Compensating correction of a receipt line (warehouse manager; reason required). */
  @RequirePermission('inventory:correct')
  @Post('goods-receipts/:code/corrections')
  @HttpCode(200)
  async correct(
    @Param('code', RECEIPT_CODE) code: string,
    @Body(new ZodValidationPipe(createReceiptCorrectionRequestSchema))
    body: CreateReceiptCorrectionRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<GoodsReceipt> {
    return receiptForViewer(
      await this.procurement.correctLine(code, body, warehouse.siteId),
      principal.permissions,
    );
  }
}
