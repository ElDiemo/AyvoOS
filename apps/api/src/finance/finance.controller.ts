import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  correctFinanceDocumentSchema,
  financeDocumentListQuerySchema,
  uploadFinanceDocumentFieldsSchema,
  voidFinanceDocumentSchema,
  type CorrectFinanceDocumentRequest,
  type FinanceDocumentDetail,
  type FinanceDocumentListQuery,
  type FinanceDocumentPage,
  type FinanceSupplier,
  type TakeOverCandidate,
  type TakeOverSupplierDocumentRequest,
  takeOverSupplierDocumentSchema,
  type VoidFinanceDocumentRequest,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';
import { FinanceDocumentsService } from './finance-documents.service.js';

const CODE = new ZodValidationPipe(z.string().regex(/^FD-\d{6,}$/));
/** Multipart sends empty optional fields as "": they mean "not given". */
const uploadFields = z.preprocess(
  (v) =>
    v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([, value]) => value !== ''))
      : v,
  uploadFinanceDocumentFieldsSchema,
);

/**
 * Admin API — Finance: received documents (doc 039, N1). Company-wide (no site). Reading needs
 * finance:documents_read; receiving, correcting and voiding finance:documents_manage.
 */
@Controller(`${ADMIN_PREFIX}/finance`)
export class FinanceController {
  constructor(private readonly documents: FinanceDocumentsService) {}

  /** Active suppliers to choose from (managed in Sklad → Dodavatelé). */
  @RequirePermission('finance:documents_manage')
  @Get('suppliers')
  suppliers(@Caller() caller: FinanceCaller): Promise<FinanceSupplier[]> {
    return this.documents.suppliers(caller);
  }

  /**
   * Supplier documents of Sklad that may be taken over — only sites whose paperwork the user may
   * read (procurement:documents_read there; checked in the service, not only here).
   */
  @RequirePermission('finance:documents_manage')
  @Get('supplier-documents')
  takeOverCandidates(
    @Query(new ZodValidationPipe(z.object({ supplierId: z.uuid().optional() })))
    query: { supplierId?: string },
    @Caller() caller: FinanceCaller,
  ): Promise<TakeOverCandidate[]> {
    return this.documents.takeOverCandidates(caller, query.supplierId);
  }

  @RequirePermission('finance:documents_manage')
  @Post('documents/take-over')
  takeOver(
    @Body(new ZodValidationPipe(takeOverSupplierDocumentSchema))
    body: TakeOverSupplierDocumentRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    return this.documents.takeOver(body, caller);
  }

  @RequirePermission('finance:documents_read')
  @Get('documents')
  list(
    @Query(new ZodValidationPipe(financeDocumentListQuerySchema)) query: FinanceDocumentListQuery,
  ): Promise<FinanceDocumentPage> {
    return this.documents.list(query);
  }

  /** multipart/form-data: uploadFinanceDocumentFieldsSchema fields + one `file` (PDF). */
  @RequirePermission('finance:documents_manage')
  @Post('documents')
  @UseInterceptors(FileInterceptor('file'))
  receive(
    @Body(new ZodValidationPipe(uploadFields)) fields: z.infer<typeof uploadFields>,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Caller() caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    if (!file) throw new BadRequestException('Přiložte originál dokladu jako pole "file".');
    return this.documents.receive(fields, file, caller);
  }

  @RequirePermission('finance:documents_read')
  @Get('documents/:code')
  detail(@Param('code', CODE) code: string): Promise<FinanceDocumentDetail> {
    return this.documents.detail(code);
  }

  /** The original, exactly as received — as a download, never rendered by the application. */
  @RequirePermission('finance:documents_read')
  @Get('documents/:code/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('X-Content-Type-Options', 'nosniff')
  async content(
    @Param('code', CODE) code: string,
    @Caller() caller: FinanceCaller,
  ): Promise<StreamableFile> {
    const { bytes, contentType, filename } = await this.documents.content(code, caller);
    return new StreamableFile(bytes, {
      type: contentType,
      disposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
    });
  }

  @RequirePermission('finance:documents_manage')
  @Post('documents/:code/correct')
  @HttpCode(200)
  correct(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(correctFinanceDocumentSchema)) body: CorrectFinanceDocumentRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    return this.documents.correct(code, body, caller);
  }

  @RequirePermission('finance:documents_manage')
  @Post('documents/:code/void')
  @HttpCode(200)
  void(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(voidFinanceDocumentSchema)) body: VoidFinanceDocumentRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<FinanceDocumentDetail> {
    return this.documents.void(code, body, caller);
  }
}
