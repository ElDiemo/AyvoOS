import {
  bottleCreationBatchCodeSchema,
  bottleListQuerySchema,
  createBottleRegistrationRequestSchema,
  labelPrintJobCodeSchema,
  type BottleCreationHistoryResponse,
  type BottleRegistrationResponse,
  type CreateBottleRegistrationRequest,
  type LabelPrintJob,
  type LabelPrintJobListResponse,
} from '@ayvo/types';
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
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BottleRegistrationService } from './bottle-registration.service.js';
import { LabelPrintJobsService } from './label-print-jobs.service.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { OperationalSite } from '../identity/access.guard.js';
import type { SiteContext } from '../inventory/warehouse-context.js';

const BATCH_CODE = new ZodValidationPipe(bottleCreationBatchCodeSchema);
const JOB_CODE = new ZodValidationPipe(labelPrintJobCodeSchema);
const historyQuerySchema = bottleListQuerySchema.pick({ page: true, pageSize: true });

/** Admin API: register bottles, manage print jobs, download print-ready PDFs. */
@Controller(ADMIN_PREFIX)
export class LabelProductionController {
  constructor(
    private readonly registration: BottleRegistrationService,
    private readonly printJobs: LabelPrintJobsService,
  ) {}

  @RequirePermission('production:bottles_create')
  @Post('bottle-registrations')
  register(
    @Body(new ZodValidationPipe(createBottleRegistrationRequestSchema))
    body: CreateBottleRegistrationRequest,
    @OperationalSite() site: SiteContext,
  ): Promise<BottleRegistrationResponse> {
    return this.registration.register(body, site.siteId);
  }

  /** Creation batches with the state of their latest print job (Bottles → Creation history). */
  @RequirePermission('production:read')
  @Get('bottle-creation-history')
  creationHistory(
    @Query(new ZodValidationPipe(historyQuerySchema)) query: z.infer<typeof historyQuerySchema>,
    @OperationalSite() site: SiteContext,
  ): Promise<BottleCreationHistoryResponse> {
    return this.printJobs.creationHistory(query.page, query.pageSize, site.siteId);
  }

  @RequirePermission('production:read')
  @Get('bottle-batches/:code/print-jobs')
  async listForBatch(
    @Param('code', BATCH_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<LabelPrintJobListResponse> {
    return { items: await this.printJobs.listForBatch(code, site.siteId) };
  }

  /** A new print job for the same bottles (e.g. to reprint). Never creates bottles. */
  @RequirePermission('production:bottles_create')
  @Post('bottle-batches/:code/print-jobs')
  createForBatch(
    @Param('code', BATCH_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<LabelPrintJob> {
    return this.printJobs.createForBatch(code, site.siteId);
  }

  @RequirePermission('production:read')
  @Get('label-print-jobs/:code')
  get(
    @Param('code', JOB_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<LabelPrintJob> {
    return this.printJobs.getByCode(code, site.siteId);
  }

  /** Renders (or retries) the job. Responds with the job; check `status` for COMPLETED/FAILED. */
  @RequirePermission('production:labels_print')
  @Post('label-print-jobs/:code/generate')
  @HttpCode(200)
  generate(
    @Param('code', JOB_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<LabelPrintJob> {
    return this.printJobs.generate(code, site.siteId);
  }

  @RequirePermission('production:read')
  @Get('label-print-jobs/:code/pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(
    @Param('code', JOB_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    const { bytes, filename } = await this.printJobs.getPdf(code, site.siteId);
    return pdfFile(bytes, filename);
  }
}

function pdfFile(bytes: Uint8Array, filename: string): StreamableFile {
  return new StreamableFile(Buffer.from(bytes), {
    type: 'application/pdf',
    disposition: `attachment; filename="${filename}"`,
    length: bytes.length,
  });
}
