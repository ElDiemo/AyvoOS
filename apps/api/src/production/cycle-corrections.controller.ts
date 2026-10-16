import {
  addCrateMemberRequestSchema,
  crateCodeSchema,
  cycleReasonRequestSchema,
  removeCrateMemberRequestSchema,
  type AddCrateMemberRequest,
  type CycleCorrectionResult,
  type CycleReasonRequest,
  type RemoveCrateMemberRequest,
} from '@ayvo/types';
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { CycleCorrectionsService } from './cycle-corrections.service.js';

const CRATE_CODE = new ZodValidationPipe(crateCodeSchema);

/**
 * Supervised crate cycle corrections (doc 025 §4.2; `production:cycle_correct`, production
 * supervisor and ADMIN, owner B4). The guard re-checks the permission and the active site on
 * every request — a replayed request included; crates of another site are "not found".
 */
@Controller(`${ADMIN_PREFIX}/crates/:code`)
export class CycleCorrectionsController {
  constructor(private readonly corrections: CycleCorrectionsService) {}

  @RequirePermission('production:cycle_correct')
  @Post('remove-bottle')
  @HttpCode(200)
  remove(
    @Param('code', CRATE_CODE) code: string,
    @Body(new ZodValidationPipe(removeCrateMemberRequestSchema)) body: RemoveCrateMemberRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<CycleCorrectionResult> {
    return this.corrections.remove(principal.userId, site.siteId, code, body);
  }

  @RequirePermission('production:cycle_correct')
  @Post('add-bottle')
  @HttpCode(200)
  add(
    @Param('code', CRATE_CODE) code: string,
    @Body(new ZodValidationPipe(addCrateMemberRequestSchema)) body: AddCrateMemberRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<CycleCorrectionResult> {
    return this.corrections.add(principal.userId, site.siteId, code, body);
  }

  @RequirePermission('production:cycle_correct')
  @Post('reopen')
  @HttpCode(200)
  reopen(
    @Param('code', CRATE_CODE) code: string,
    @Body(new ZodValidationPipe(cycleReasonRequestSchema)) body: CycleReasonRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<CycleCorrectionResult> {
    return this.corrections.reopen(principal.userId, site.siteId, code, body);
  }

  @RequirePermission('production:cycle_correct')
  @Post('abort-cycle')
  @HttpCode(200)
  abort(
    @Param('code', CRATE_CODE) code: string,
    @Body(new ZodValidationPipe(cycleReasonRequestSchema)) body: CycleReasonRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<CycleCorrectionResult> {
    return this.corrections.abort(principal.userId, site.siteId, code, body);
  }
}
