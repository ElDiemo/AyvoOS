import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { CommissionTermsService } from './commission-terms.service.js';
import { CommissionsController } from './commissions.controller.js';

/**
 * commissions module — Obchod → Provize (ADR 0046, doc 068; PR 1a PROTOTYPE): the commission
 * terms of salespeople. Own table only; who is a salesperson comes from `sales`. A new module so
 * that PR 1b can import `contracts` and `sales` without a cycle (ADR 0046 §2). No amounts,
 * invoices or payments: those are Finance's (later PRs).
 */
@Module({
  imports: [SalesModule],
  controllers: [CommissionsController],
  providers: [CommissionTermsService],
})
export class CommissionsModule {}
