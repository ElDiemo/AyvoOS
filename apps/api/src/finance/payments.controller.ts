import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  allocatePaymentSchema,
  paymentCodeSchema,
  simulateStatementSchema,
  type AllocatePaymentRequest,
  type IncomingPayment,
  type PaymentLoadResult,
  type PaymentsPage,
  type SimulateStatementRequest,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { Caller, type FinanceCaller } from './finance-access.guard.js';
import { PaymentsService } from './payments.service.js';

const CODE = new ZodValidationPipe(paymentCodeSchema);
const requestOnly = z.strictObject({ requestId: z.uuid() });

/**
 * Incoming payments (N3B-2, doc 041 §8): reading with finance:invoices_read; recording payments
 * from read bank transactions, a simulated statement (outside production) and allocating by hand
 * with finance:payments_manage (ADMIN only). Nothing here ever calls the bank.
 */
@Controller(`${ADMIN_PREFIX}/finance/payments`)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermission('finance:invoices_read')
  @Get()
  page(): Promise<PaymentsPage> {
    return this.payments.page();
  }

  @RequirePermission('finance:payments_manage')
  @Post('simulate')
  @HttpCode(200)
  simulate(
    @Body(new ZodValidationPipe(simulateStatementSchema)) body: SimulateStatementRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<PaymentLoadResult> {
    return this.payments.simulate(body, caller);
  }

  @RequirePermission('finance:payments_manage')
  @Post('import-bank')
  @HttpCode(200)
  importBank(
    @Body(new ZodValidationPipe(requestOnly)) body: z.infer<typeof requestOnly>,
    @Caller() caller: FinanceCaller,
  ): Promise<PaymentLoadResult> {
    return this.payments.importBank(body.requestId, caller);
  }

  @RequirePermission('finance:payments_manage')
  @Post(':code/allocations')
  @HttpCode(200)
  allocate(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(allocatePaymentSchema)) body: AllocatePaymentRequest,
    @Caller() caller: FinanceCaller,
  ): Promise<IncomingPayment> {
    return this.payments.allocate(code, body, caller);
  }
}
