import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  approveCommissionStatementSchema,
  commissionMineQuerySchema,
  commissionPreviewQuerySchema,
  commissionStatementsQuerySchema,
  recordSalespersonInvoiceSchema,
  type ApproveCommissionStatement,
  type CommissionMine,
  type CommissionPreview,
  type CommissionPreviewQuery,
  type CommissionStatement,
  type CommissionStatementList,
  type CommissionStatementsQuery,
  type RecordSalespersonInvoice,
} from '@ayvo/types';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CommissionClosingService } from './commission-closing.service.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';

/**
 * Obchod → Provize, the Finance side (doc 069 §5): the monthly commission statements.
 * `finance:commissions_manage` (preview, approve, the approved list) is ADMIN only (O8); a
 * salesperson (`sales:work`) sees only their own approved statement's state and amount.
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

  /** Approves one salesperson's statement as previewed (doc 069 §5d). */
  @RequirePermission('finance:commissions_manage')
  @Post('statements')
  @HttpCode(200)
  approve(
    @Body(new ZodValidationPipe(approveCommissionStatementSchema)) req: ApproveCommissionStatement,
    @Caller() caller: FinanceCaller,
  ): Promise<CommissionStatement> {
    return this.closing.approve(req, caller);
  }

  /**
   * The salesperson's one invoice on an approved statement and the planned payout day (doc 069
   * §5d "Payout plan"). Nothing is paid here.
   */
  @RequirePermission('finance:commissions_manage')
  @Post('statements/:id/salesperson-invoice')
  @HttpCode(200)
  recordInvoice(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(recordSalespersonInvoiceSchema)) req: RecordSalespersonInvoice,
    @Caller() caller: FinanceCaller,
  ): Promise<CommissionStatement> {
    return this.closing.recordInvoice(id, req, caller);
  }

  /** The approved statements of a month. */
  @RequirePermission('finance:commissions_manage')
  @Get('statements')
  list(
    @Query(new ZodValidationPipe(commissionStatementsQuerySchema)) q: CommissionStatementsQuery,
  ): Promise<CommissionStatementList> {
    return this.closing.list(q);
  }

  /** The caller's own approved statement: state and one amount ("Zpracovává se" before). */
  @RequirePermission('sales:work')
  @Get('mine')
  mine(
    @Query(new ZodValidationPipe(commissionMineQuerySchema)) q: CommissionStatementsQuery,
    @Caller() caller: FinanceCaller,
  ): Promise<CommissionMine> {
    return this.closing.mine(q, caller);
  }
}
