import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  createBillingAgreementSchema,
  createBillingCustomerSchema,
  effectiveTermsQuerySchema,
  newBillingAgreementVersionSchema,
  newBillingCustomerVersionSchema,
  newPriceListVersionSchema,
  type BillingAgreement,
  type BillingAgreementDetail,
  type BillingCustomer,
  type BillingCustomerDetail,
  type BillingSummary,
  type CreateBillingAgreementRequest,
  type CreateBillingCustomerRequest,
  type EffectiveTermsPage,
  type EffectiveTermsQuery,
  type FinanceContractHotel,
  type NewBillingAgreementVersionRequest,
  type NewBillingCustomerVersionRequest,
  type NewPriceListVersionRequest,
  type PriceListVersion,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { BillingSettingsService } from './billing-settings.service.js';
import { CoreClient } from './core-client.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';

const CUSTOMER = new ZodValidationPipe(z.string().regex(/^CU-\d{6,}$/));
const AGREEMENT = new ZodValidationPipe(z.string().regex(/^BA-\d{6,}$/));

/**
 * Hotel billing settings of the Finance unit (doc 040, N3A-1): customers, hotel billing
 * agreements with versioned terms, the default price list and the terms effective for a month.
 * Reading needs finance:billing_read; every change finance:billing_manage. Company-wide (no
 * site). Nothing here computes an amount or issues anything.
 */
@Controller(`${ADMIN_PREFIX}/finance/billing`)
export class BillingSettingsController {
  constructor(
    private readonly billing: BillingSettingsService,
    private readonly core: CoreClient,
  ) {}

  /** The core's hotels to choose from (identity and address only). */
  @RequirePermission('finance:billing_read')
  @Get('hotels')
  hotels(@Caller() caller: FinanceCaller): Promise<FinanceContractHotel[]> {
    return this.core.hotels(caller.sessionToken);
  }

  @RequirePermission('finance:billing_read')
  @Get('customers')
  customers(): Promise<BillingCustomer[]> {
    return this.billing.listCustomers();
  }

  @RequirePermission('finance:billing_read')
  @Get('customers/:code')
  customer(@Param('code', CUSTOMER) code: string): Promise<BillingCustomerDetail> {
    return this.billing.customerDetail(code);
  }

  @RequirePermission('finance:billing_manage')
  @Post('customers')
  createCustomer(
    @Body(new ZodValidationPipe(createBillingCustomerSchema)) body: CreateBillingCustomerRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<BillingCustomerDetail> {
    return this.billing.createCustomer(body, caller);
  }

  @RequirePermission('finance:billing_manage')
  @Post('customers/:code/versions')
  newCustomerVersion(
    @Param('code', CUSTOMER) code: string,
    @Body(new ZodValidationPipe(newBillingCustomerVersionSchema))
    body: NewBillingCustomerVersionRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<BillingCustomerDetail> {
    return this.billing.newCustomerVersion(code, body, caller);
  }

  /** How many customers and agreements exist (doc 042 §3c, the overview): counts only. */
  @RequirePermission('finance:billing_read')
  @Get('summary')
  summary(): Promise<BillingSummary> {
    return this.billing.summary();
  }

  @RequirePermission('finance:billing_read')
  @Get('price-list')
  priceList(): Promise<PriceListVersion[]> {
    return this.billing.listPriceList();
  }

  @RequirePermission('finance:billing_manage')
  @Post('price-list')
  newPriceListVersion(
    @Body(new ZodValidationPipe(newPriceListVersionSchema)) body: NewPriceListVersionRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<PriceListVersion> {
    return this.billing.newPriceListVersion(body, caller);
  }

  @RequirePermission('finance:billing_read')
  @Get('agreements')
  agreements(): Promise<BillingAgreement[]> {
    return this.billing.listAgreements();
  }

  /** What applies to every agreement in a month, as known now or at `asOf` (no amounts). */
  @RequirePermission('finance:billing_read')
  @Get('agreements/effective')
  effective(
    @Query(new ZodValidationPipe(effectiveTermsQuerySchema)) query: EffectiveTermsQuery,
  ): Promise<EffectiveTermsPage> {
    return this.billing.effectiveTerms(query.month, query.asOf);
  }

  @RequirePermission('finance:billing_read')
  @Get('agreements/:code')
  agreement(@Param('code', AGREEMENT) code: string): Promise<BillingAgreementDetail> {
    return this.billing.agreementDetail(code);
  }

  @RequirePermission('finance:billing_manage')
  @Post('agreements')
  createAgreement(
    @Body(new ZodValidationPipe(createBillingAgreementSchema)) body: CreateBillingAgreementRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    return this.billing.createAgreement(body, caller);
  }

  @RequirePermission('finance:billing_manage')
  @Post('agreements/:code/versions')
  newAgreementVersion(
    @Param('code', AGREEMENT) code: string,
    @Body(new ZodValidationPipe(newBillingAgreementVersionSchema))
    body: NewBillingAgreementVersionRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    return this.billing.newAgreementVersion(code, body, caller);
  }
}
