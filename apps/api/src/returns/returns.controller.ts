import {
  type AfterWashQueue,
  type AfterWashScanResult,
  closeOutReturnIssueRequestSchema,
  emptyReturnLineRequestSchema,
  identifyReturnIssueRequestSchema,
  openReturnReceiptRequestSchema,
  returnBottleScanRequestSchema,
  returnIssueCodeSchema,
  returnPumpCountRequestSchema,
  returnReceiptCodeSchema,
  returnRequestSchema,
  returnScanRequestSchema,
  type CloseOutReturnIssueRequest,
  type EmptyReturnLineRequest,
  type IdentifyReturnIssueRequest,
  type OpenReturnReceiptRequest,
  type ReturnBottleScanRequest,
  type ReturnBottleScanResult,
  type ReturnCrateScanResult,
  type ReturnHotelOption,
  type ReturnIssueResult,
  type ReturnIssueSummary,
  type ReturnPumpCountRequest,
  type ReturnReceiptDetail,
  type ReturnReceiptList,
  type ReturnRequest,
  type ReturnScanRequest,
  type ReturnsOverview,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { AfterWashService } from './after-wash.service.js';
import { ReturnReceiptsService } from './return-receipts.service.js';

const CODE = new ZodValidationPipe(returnReceiptCodeSchema);
const ISSUE = new ZodValidationPipe(returnIssueCodeSchema);

/**
 * Výroba → Oběh lahví → Příjem vratek (doc 047 §4, R1.1 §6.3): receipts of the active site only —
 * another site's receipt, line or issue is not found, also before a replay. A crate scan frees the
 * crate; a bottle scan needs no crate (the receipt's BOTTLES line).
 */
@Controller(`${ADMIN_PREFIX}/returns`)
export class ReturnsController {
  constructor(
    private readonly returns: ReturnReceiptsService,
    private readonly afterWash: AfterWashService,
  ) {}

  @RequirePermission('returns:receive')
  @Get('receipts')
  list(@OperationalSite() site: SiteContext): Promise<ReturnReceiptList> {
    return this.returns.list(site);
  }

  @RequirePermission('returns:receive')
  @Get('hotels')
  hotels(@OperationalSite() site: SiteContext): Promise<ReturnHotelOption[]> {
    return this.returns.hotelOptions(site);
  }

  @RequirePermission('returns:receive')
  @Get('overview')
  overview(@OperationalSite() site: SiteContext): Promise<ReturnsOverview> {
    return this.returns.overview(site);
  }

  @RequirePermission('returns:receive')
  @Post('receipts')
  open(
    @Body(new ZodValidationPipe(openReturnReceiptRequestSchema)) body: OpenReturnReceiptRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnReceiptDetail> {
    return this.returns.open(principal, site, body);
  }

  @RequirePermission('returns:receive')
  @Get('receipts/:code')
  detail(
    @Param('code', CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnReceiptDetail> {
    return this.returns.detail(site, code);
  }

  @RequirePermission('returns:receive')
  @Post('receipts/:code/crates')
  @HttpCode(200)
  scanCrate(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(returnScanRequestSchema)) body: ReturnScanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnCrateScanResult> {
    return this.returns.scanCrate(principal, site, code, body);
  }

  @RequirePermission('returns:receive')
  @Post('receipts/:code/bottles')
  @HttpCode(200)
  scanBottle(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(returnBottleScanRequestSchema)) body: ReturnBottleScanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnBottleScanResult> {
    return this.returns.scanBottle(principal, site, code, body);
  }

  @RequirePermission('returns:receive')
  @Post('receipts/:code/unreadable')
  @HttpCode(200)
  unreadable(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(returnRequestSchema)) body: ReturnRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnIssueResult> {
    return this.returns.unreadable(principal, site, code, body);
  }

  /** Vyprázdněno of an R1 line only (an open receipt from before R1.1, doc 047 §6.3 6). */
  @RequirePermission('returns:receive')
  @Post('receipts/:code/lines/:lineId/empty')
  @HttpCode(200)
  emptyLine(
    @Param('code', CODE) code: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(emptyReturnLineRequestSchema)) body: EmptyReturnLineRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnReceiptDetail> {
    return this.returns.emptyLine(principal, site, code, lineId, body);
  }

  @RequirePermission('returns:receive')
  @Post('receipts/:code/pumps')
  @HttpCode(200)
  countPumps(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(returnPumpCountRequestSchema)) body: ReturnPumpCountRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnReceiptDetail> {
    return this.returns.countPumps(principal, site, code, body);
  }

  @RequirePermission('returns:receive')
  @Post('receipts/:code/close')
  @HttpCode(200)
  close(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(returnRequestSchema)) body: ReturnRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnReceiptDetail> {
    return this.returns.close(principal, site, code, body);
  }

  @RequirePermission('returns:receive')
  @Post('issues/:code/identify')
  @HttpCode(200)
  identify(
    @Param('code', ISSUE) code: string,
    @Body(new ZodValidationPipe(identifyReturnIssueRequestSchema)) body: IdentifyReturnIssueRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnBottleScanResult> {
    return this.returns.identifyIssue(principal, site, code, body);
  }

  @RequirePermission('returns:correct')
  @Post('issues/:code/close-out')
  @HttpCode(200)
  closeOut(
    @Param('code', ISSUE) code: string,
    @Body(new ZodValidationPipe(closeOutReturnIssueRequestSchema)) body: CloseOutReturnIssueRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ReturnIssueSummary> {
    return this.returns.closeOutIssue(principal, site, code, body);
  }

  /** R2 "Po mytí" (doc 048 §2): the queue of the active site. */
  @RequirePermission('returns:receive')
  @Get('after-wash')
  afterWashQueue(@OperationalSite() site: SiteContext): Promise<AfterWashQueue> {
    return this.afterWash.queue(site);
  }

  /** R2 "Po mytí": RETURNED → READY_FOR_REUSE of one washed and inspected bottle. */
  @RequirePermission('returns:receive')
  @Post('after-wash')
  @HttpCode(200)
  afterWashScan(
    @Body(new ZodValidationPipe(returnScanRequestSchema)) body: ReturnScanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<AfterWashScanResult> {
    return this.afterWash.scan(principal, site, body);
  }
}
