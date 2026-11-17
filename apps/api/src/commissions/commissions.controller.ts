import {
  commissionTermsQuerySchema,
  recordCommissionTermsSchema,
  type CommissionTerms,
  type CommissionTermsOverviewRow,
  type CommissionTermsQuery,
  type RecordCommissionTermsRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { CommissionTermsService } from './commission-terms.service.js';

/**
 * Obchod → Provize — commission terms (doc 068 §4.1, PR 1a). There is no PUT, PATCH or
 * DELETE: a change is a new version. The salesperson's own terms come only from the session.
 */
@Controller(`${ADMIN_PREFIX}/sales/commission-terms`)
export class CommissionsController {
  constructor(private readonly terms: CommissionTermsService) {}

  @Get('mine')
  @RequirePermission('sales:work')
  mine(@CurrentPrincipal() p: Principal): Promise<CommissionTerms> {
    return this.terms.mine(p);
  }

  /** Without `salesperson`: everyone's valid version; with it: that person's history. */
  @Get()
  @RequirePermission('sales:commission_terms_manage')
  list(
    @Query(new ZodValidationPipe(commissionTermsQuerySchema)) q: CommissionTermsQuery,
  ): Promise<CommissionTermsOverviewRow[] | CommissionTerms> {
    return q.salesperson ? this.terms.forSalesperson(q.salesperson) : this.terms.overview();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('sales:commission_terms_manage')
  record(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(recordCommissionTermsSchema)) body: RecordCommissionTermsRequest,
  ): Promise<CommissionTerms> {
    return this.terms.record(body, p);
  }
}
