import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  cancelInvoiceSchema,
  createTestInvoiceSchema,
  createTestRunSchema,
  invoiceListQuerySchema,
  invoiceNumberSchema,
  testRunPreviewQuerySchema,
  type CancelInvoiceRequest,
  type CreateTestInvoiceRequest,
  type CreateTestRunRequest,
  type InvoiceDetail,
  type InvoiceListQuery,
  type InvoicesOverview,
  type InvoiceSummary,
  type TestRunPreview,
  type TestRunResult,
} from '@ayvo/types';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';
import { InvoicesService } from './invoices.service.js';

const NUMBER = new ZodValidationPipe(invoiceNumberSchema);

/**
 * TEST invoices (N3A-2b, doc 040 §9): reading needs finance:invoices_read; issuing and cancelling
 * a TEST invoice finance:invoices_test (both ADMIN only). There is no live issuing route.
 */
@Controller(`${ADMIN_PREFIX}/finance/invoices`)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @RequirePermission('finance:invoices_read')
  @Get()
  list(
    @Query(new ZodValidationPipe(invoiceListQuerySchema)) query: InvoiceListQuery,
  ): Promise<InvoiceSummary[]> {
    return this.invoices.list(query);
  }

  /** Sums for the Finance overview (doc 042 §3a), computed in the database; reads only. */
  @RequirePermission('finance:invoices_read')
  @Get('overview')
  overview(): Promise<InvoicesOverview> {
    return this.invoices.overview();
  }

  @RequirePermission('finance:invoices_test')
  @Post('test')
  issueTest(
    @Body(new ZodValidationPipe(createTestInvoiceSchema)) body: CreateTestInvoiceRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<InvoiceDetail> {
    return this.invoices.issueTest(body, caller);
  }

  /** A month's agreements and what a TEST invoice of each would say (doc 040 §11); reads only. */
  @RequirePermission('finance:invoices_test', 'finance:billing_read')
  @Get('test-run/preview')
  testRunPreview(
    @Query(new ZodValidationPipe(testRunPreviewQuerySchema)) query: { month: string },
  ): Promise<TestRunPreview> {
    return this.invoices.testRunPreview(query.month);
  }

  @RequirePermission('finance:invoices_test')
  @Post('test-run')
  issueTestRun(
    @Body(new ZodValidationPipe(createTestRunSchema)) body: CreateTestRunRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<TestRunResult> {
    return this.invoices.issueTestRun(body, caller);
  }

  @RequirePermission('finance:invoices_read')
  @Get(':number')
  detail(@Param('number', NUMBER) number: string): Promise<InvoiceDetail> {
    return this.invoices.detail(number);
  }

  /** The PDF exactly as stored at issuing (its hash is checked). */
  @RequirePermission('finance:invoices_read')
  @Get(':number/pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(@Param('number', NUMBER) number: string): Promise<StreamableFile> {
    const { bytes, filename } = await this.invoices.pdf(number);
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequirePermission('finance:invoices_test')
  @Post(':number/cancel')
  @HttpCode(200)
  cancel(
    @Param('number', NUMBER) number: string,
    @Body(new ZodValidationPipe(cancelInvoiceSchema)) body: CancelInvoiceRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<InvoiceDetail> {
    return this.invoices.cancel(number, body, caller);
  }
}
