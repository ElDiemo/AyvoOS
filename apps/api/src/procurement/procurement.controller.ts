import {
  archiveSupplierRequestSchema,
  createGoodsReceiptRequestSchema,
  createReceiptCorrectionRequestSchema,
  createSupplierRequestSchema,
  goodsReceiptCodeSchema,
  goodsReceiptListQuerySchema,
  linkReceiptDocumentRequestSchema,
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

const RECEIPT_CODE = new ZodValidationPipe(goodsReceiptCodeSchema);
const supplierListQuerySchema = z.object({ archived: z.enum(['true', 'false']).default('false') });

/**
 * Admin API: suppliers, supplier documents, goods receipts (doc 018). Future permissions:
 * procurement.suppliers.manage, inventory.receive, inventory.correct, inventory.read(.prices).
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

  @RequirePermission('inventory:read')
  @Get('suppliers/:id/documents')
  documents(@Param('id', ParseUUIDPipe) id: string): Promise<SupplierDocument[]> {
    return this.procurement.listDocuments(id);
  }

  /** multipart/form-data: fields of uploadSupplierDocumentFieldsSchema + one `file` (PDF/JPEG/PNG). */
  @RequirePermission('inventory:receive')
  @Post('supplier-documents')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Body(new ZodValidationPipe(uploadSupplierDocumentFieldsSchema))
    fields: UploadSupplierDocumentFields,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
  ): Promise<SupplierDocument> {
    if (!file) throw new BadRequestException('Attach the document as the "file" field');
    return this.procurement.uploadDocument(fields, file);
  }

  @RequirePermission('inventory:read')
  @Get('supplier-documents/:id/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('X-Content-Type-Options', 'nosniff')
  async documentContent(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const { bytes, contentType, filename } = await this.procurement.getDocumentContent(id);
    return new StreamableFile(bytes, {
      type: contentType,
      disposition: `inline; filename="${filename.replace(/"/g, '')}"`,
    });
  }

  @RequirePermission('inventory:read')
  @Get('goods-receipts')
  receipts(
    @Query(new ZodValidationPipe(goodsReceiptListQuerySchema)) query: GoodsReceiptListQuery,
  ): Promise<GoodsReceiptPage> {
    return this.procurement.listReceipts(query);
  }

  @RequirePermission('inventory:receive')
  @Post('goods-receipts')
  createReceipt(
    @Body(new ZodValidationPipe(createGoodsReceiptRequestSchema)) body: CreateGoodsReceiptRequest,
  ): Promise<GoodsReceipt> {
    return this.procurement.createReceipt(body);
  }

  @RequirePermission('inventory:read')
  @Get('goods-receipts/:code')
  receipt(@Param('code', RECEIPT_CODE) code: string): Promise<GoodsReceipt> {
    return this.procurement.getReceipt(code);
  }

  /** Append-only: adds a document (e.g. the invoice that arrived after the goods). */
  @RequirePermission('inventory:receive')
  @Post('goods-receipts/:code/documents')
  @HttpCode(200)
  linkDocument(
    @Param('code', RECEIPT_CODE) code: string,
    @Body(new ZodValidationPipe(linkReceiptDocumentRequestSchema)) body: LinkReceiptDocumentRequest,
  ): Promise<GoodsReceipt> {
    return this.procurement.linkDocument(code, body);
  }

  /** Compensating correction of a receipt line (warehouse manager; reason required). */
  @RequirePermission('inventory:correct')
  @Post('goods-receipts/:code/corrections')
  @HttpCode(200)
  correct(
    @Param('code', RECEIPT_CODE) code: string,
    @Body(new ZodValidationPipe(createReceiptCorrectionRequestSchema))
    body: CreateReceiptCorrectionRequest,
  ): Promise<GoodsReceipt> {
    return this.procurement.correctLine(code, body);
  }
}
