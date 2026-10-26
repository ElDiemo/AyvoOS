import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  createIssuerBankAccountSchema,
  newIssuerBankAccountVersionSchema,
  newIssuerVersionSchema,
  setDefaultAccountSchema,
  type CreateIssuerBankAccountRequest,
  type IssuerSettings,
  type NewIssuerBankAccountVersionRequest,
  type NewIssuerVersionRequest,
  type SetDefaultAccountRequest,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';
import { IssuerSettingsService } from './issuer-settings.service.js';

const ACCOUNT = new ZodValidationPipe(z.string().regex(/^IB-\d{6,}$/));

/**
 * Our company (issuer) and the bank accounts printed on invoices (N3A-2a, doc 040 §8). Reading
 * and changing need the same finance:issuer_manage (ADMIN only): no other role is given this
 * configuration at all. Never the bank connection or its secrets (doc 041).
 */
@Controller(`${ADMIN_PREFIX}/finance/issuer`)
export class IssuerSettingsController {
  constructor(private readonly issuer: IssuerSettingsService) {}

  @RequirePermission('finance:issuer_manage')
  @Get()
  settings(): Promise<IssuerSettings> {
    return this.issuer.settings();
  }

  @RequirePermission('finance:issuer_manage')
  @Post('versions')
  newVersion(
    @Body(new ZodValidationPipe(newIssuerVersionSchema)) body: NewIssuerVersionRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    return this.issuer.newIssuerVersion(body, caller);
  }

  @RequirePermission('finance:issuer_manage')
  @Post('bank-accounts')
  createAccount(
    @Body(new ZodValidationPipe(createIssuerBankAccountSchema))
    body: CreateIssuerBankAccountRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    return this.issuer.createAccount(body, caller);
  }

  @RequirePermission('finance:issuer_manage')
  @Post('bank-accounts/:code/versions')
  newAccountVersion(
    @Param('code', ACCOUNT) code: string,
    @Body(new ZodValidationPipe(newIssuerBankAccountVersionSchema))
    body: NewIssuerBankAccountVersionRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    return this.issuer.newAccountVersion(code, body, caller);
  }

  @RequirePermission('finance:issuer_manage')
  @Post('default-accounts')
  setDefault(
    @Body(new ZodValidationPipe(setDefaultAccountSchema)) body: SetDefaultAccountRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    return this.issuer.setDefault(body, caller);
  }
}
