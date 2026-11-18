import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { CommissionTermsService } from './commission-terms.service.js';
import { CommissionsController } from './commissions.controller.js';
import { HotelAttributionController } from './hotel-attribution.controller.js';
import { HotelAttributionService } from './hotel-attribution.service.js';

/**
 * commissions module — Obchod → Provize (ADR 0046, doc 068): the commission terms of salespeople
 * (PR 1a) and who gets the commission for a hotel, with the terms applied to it, and the
 * portfolio (PR 1b). Own tables only; who is a salesperson and the prospect's owner come from
 * `sales`, hotels from `customers`, signed contracts from `contracts` (ADR 0046 §2). No amounts,
 * invoices or payments: those are Finance's (later PRs).
 */
@Module({
  imports: [SalesModule, CustomersModule, ContractsModule],
  controllers: [CommissionsController, HotelAttributionController],
  providers: [CommissionTermsService, HotelAttributionService],
})
export class CommissionsModule {}
