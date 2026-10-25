import { Module } from '@nestjs/common';
import { ProcurementModule } from '../procurement/procurement.module.js';
import { FinanceContractController } from './finance-contract.controller.js';

/**
 * The core's side of the Finance unit (ADR 0039): the internal contract only. Finance itself
 * runs in its own container (apps/api/src/finance, `node dist/finance/main.js`).
 */
@Module({
  imports: [ProcurementModule],
  controllers: [FinanceContractController],
})
export class FinanceContractModule {}
