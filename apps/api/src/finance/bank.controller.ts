import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  bankTransactionListQuerySchema,
  type BankStatus,
  type BankSyncResult,
  type BankTransactionListQuery,
  type BankTransactionPage,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { BankSyncService } from './bank-sync.service.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';

/**
 * Bank transactions read from Raiffeisenbank Premium API (N3B-1, doc 041). Reading needs
 * finance:bank_read; starting a read from the bank also finance:bank_sync. Nothing here sends
 * anything to the bank but the documented read of transactions; no secret is ever returned.
 */
@Controller(`${ADMIN_PREFIX}/finance/bank`)
export class BankController {
  constructor(private readonly bank: BankSyncService) {}

  /** The connection as configured (environment, certificate readable + expiry, accounts, runs). */
  @RequirePermission('finance:bank_read')
  @Get('status')
  status(): Promise<BankStatus> {
    return this.bank.status();
  }

  @RequirePermission('finance:bank_read')
  @Get('transactions')
  transactions(
    @Query(new ZodValidationPipe(bankTransactionListQuerySchema)) query: BankTransactionListQuery,
  ): Promise<BankTransactionPage> {
    return this.bank.transactions(query);
  }

  /** Reads new transactions of every configured account now; each account ends as its own run. */
  @RequirePermission('finance:bank_read', 'finance:bank_sync')
  @Post('sync')
  @HttpCode(200)
  sync(
    @Body(new ZodValidationPipe(z.object({}).strict())) _body: Record<string, never>,
    @Caller() caller: FinanceCaller,
  ): Promise<BankSyncResult> {
    return this.bank.sync(caller);
  }
}
