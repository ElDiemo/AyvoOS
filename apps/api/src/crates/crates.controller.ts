import {
  CRATE_LABEL_SIZE_MM,
  catalogCodeSchema,
  crateCodeSchema,
  crateListQuerySchema,
  createCrateLabelPrintJobRequestSchema,
  labelPrintJobCodeSchema,
  registerCratesRequestSchema,
  type CrateDetail,
  type CrateLabelPrintJob,
  type CrateListQuery,
  type CratePage,
  type CrateRegistration,
  type CreateCrateLabelPrintJobRequest,
  type RegisterCratesRequest,
} from '@ayvo/types';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import { publicQrUrl } from '../common/qr-policy.js';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { CrateLabelPrintJobsService } from './crate-label-print-jobs.service.js';
import { CratesService } from './crates.service.js';

const CRATE_CODE = new ZodValidationPipe(crateCodeSchema);
const JOB_CODE = new ZodValidationPipe(labelPrintJobCodeSchema);
const sizeMm = z.coerce.number().int().min(CRATE_LABEL_SIZE_MM.min).max(CRATE_LABEL_SIZE_MM.max);
const previewQuerySchema = z.object({
  widthMm: sizeMm,
  heightMm: sizeMm,
  crateType: catalogCodeSchema.optional(),
});

/**
 * Admin API of physical crates (doc 025 A1). Everything acts on the session's active site
 * (doc 022): crates, print jobs and history of another site are "not found".
 */
@Controller(ADMIN_PREFIX)
export class CratesController {
  constructor(
    private readonly crates: CratesService,
    private readonly printJobs: CrateLabelPrintJobsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @RequirePermission('crates:register')
  @Post('crate-registrations')
  register(
    @Body(new ZodValidationPipe(registerCratesRequestSchema)) body: RegisterCratesRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<CrateRegistration> {
    return this.crates.register(principal.userId, body, site);
  }

  @RequirePermission('crates:read')
  @Get('crates')
  list(
    @Query(new ZodValidationPipe(crateListQuerySchema)) query: CrateListQuery,
    @OperationalSite() site: SiteContext,
  ): Promise<CratePage> {
    return this.crates.list(site.siteId, query);
  }

  @RequirePermission('crates:read')
  @Get('crates/:code')
  async detail(
    @Param('code', CRATE_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<CrateDetail> {
    const crate = await this.crates.findOfSite(code, site.siteId);
    return this.crates.detail(
      code,
      site.siteId,
      await this.printJobs.listForCrate(crate.id),
      publicQrUrl(this.env.PUBLIC_QR_BASE_URL, crate.qrToken),
    );
  }

  /** Creates a print job for crates of the active site and renders it (a reprint is a new job). */
  @RequirePermission('crates:register')
  @Post('crate-label-print-jobs')
  createPrintJob(
    @Body(new ZodValidationPipe(createCrateLabelPrintJobRequestSchema))
    body: CreateCrateLabelPrintJobRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<CrateLabelPrintJob> {
    return this.printJobs.create(principal.userId, body, site.siteId);
  }

  @RequirePermission('crates:read')
  @Get('crate-label-print-jobs/:code')
  getPrintJob(
    @Param('code', JOB_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<CrateLabelPrintJob> {
    return this.printJobs.getByCode(code, site.siteId);
  }

  /** Retries a FAILED (or abandoned) rendering. */
  @RequirePermission('crates:register')
  @Post('crate-label-print-jobs/:code/generate')
  @HttpCode(200)
  generate(
    @Param('code', JOB_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<CrateLabelPrintJob> {
    return this.printJobs.generate(code, site.siteId);
  }

  @RequirePermission('crates:read')
  @Get('crate-label-print-jobs/:code/pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(
    @Param('code', JOB_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    const { bytes, filename } = await this.printJobs.getPdf(code, site.siteId);
    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
      length: bytes.length,
    });
  }

  /** A one-page PREVIEW at the chosen size (placeholder QR, nothing recorded). */
  @RequirePermission('crates:register')
  @Get('crate-label-preview')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async preview(
    @Query(new ZodValidationPipe(previewQuerySchema)) query: z.infer<typeof previewQuerySchema>,
  ): Promise<StreamableFile> {
    const bytes = await this.printJobs.preview(query.widthMm, query.heightMm, query.crateType);
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: 'inline; filename="crate-label-preview.pdf"',
      length: bytes.length,
    });
  }
}
