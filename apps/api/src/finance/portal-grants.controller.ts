import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  financePortalInvitationSchema,
  financePortalGrantIssueSchema,
  financePortalGrantReplaceSchema,
  type FinancePortalGrantIssue,
  type FinancePortalGrantReplace,
  type FinancePortalAccess,
  type FinancePortalGrantResult,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';
import { FinancePortalGrantsService } from './portal-grants.service.js';

/**
 * "Přístup do portálu" on a payer page (ADR 0045 §4): issue and replace hotel portal grants
 * through Finance's check of the payer and its hotels. ADMIN only — both permissions, evaluated by
 * the core on this request. Revocation is the core's own route (no Finance check needed).
 */
@Controller(`${ADMIN_PREFIX}/finance/portal-grants`)
export class FinancePortalGrantsController {
  constructor(private readonly grants: FinancePortalGrantsService) {}

  @Get()
  @RequirePermission('finance:billing_read', 'identity:portal_grants_manage')
  ofPayer(
    @Query(new ZodValidationPipe(z.object({ payerCustomerId: z.uuid() })))
    query: { payerCustomerId: string },
    @Caller() caller: FinanceCaller,
  ): Promise<FinancePortalAccess> {
    return this.grants.ofPayer(caller, query.payerCustomerId);
  }

  @Post()
  @RequirePermission('finance:billing_read', 'identity:portal_grants_manage')
  issue(
    @Body(new ZodValidationPipe(financePortalGrantIssueSchema)) body: FinancePortalGrantIssue,
    @Caller() caller: FinanceCaller,
  ): Promise<FinancePortalGrantResult> {
    return this.grants.issue(caller, body);
  }

  @Post(':id/replace')
  @RequirePermission('finance:billing_read', 'identity:portal_grants_manage')
  replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(financePortalGrantReplaceSchema)) body: FinancePortalGrantReplace,
    @Caller() caller: FinanceCaller,
  ): Promise<FinancePortalGrantResult> {
    return this.grants.replace(caller, id, body);
  }

  /** A new invitation attempt for the grant's account (after a FAILED one): its own requestId. */
  @Post(':id/invitation')
  @RequirePermission('finance:billing_read', 'identity:portal_grants_manage')
  reinvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(financePortalInvitationSchema)) body: { requestId: string },
    @Caller() caller: FinanceCaller,
  ): Promise<{ invitation: FinancePortalGrantResult['invitation'] }> {
    return this.grants.reinvite(caller, id, body.requestId);
  }
}
