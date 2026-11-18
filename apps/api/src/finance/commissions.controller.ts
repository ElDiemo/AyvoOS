import { Controller, Get, Query } from '@nestjs/common';
import {
  commissionPreviewQuerySchema,
  type CommissionPreview,
  type CommissionPreviewQuery,
} from '@ayvo/types';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CommissionClosingService } from './commission-closing.service.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';

/**
 * Obchod → Provize, the Finance side (doc 069 §5): the monthly commission statements. PR 2b
 * previews only (no write); approving (PR 2c) and the salesperson's own view follow.
 * `finance:commissions_manage` is ADMIN only (O8).
 */
@Controller(`${ADMIN_PREFIX}/finance/commissions`)
export class CommissionsController {
  constructor(private readonly closing: CommissionClosingService) {}

  /** The statements due in a closed month, per salesperson; nothing is written. */
  @RequirePermission('finance:commissions_manage')
  @Get('preview')
  preview(
    @Query(new ZodValidationPipe(commissionPreviewQuerySchema)) q: CommissionPreviewQuery,
    @Caller() caller: FinanceCaller,
  ): Promise<CommissionPreview> {
    return this.closing.preview(q, caller);
  }
}
