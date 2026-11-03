import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { ContractDraftsController } from './contract-drafts.controller.js';
import { ContractDraftsService } from './contract-drafts.service.js';

/**
 * contracts module (ADR 0043, doc 045): contract drafts prepared by hand at a prospect or a hotel,
 * printed from a versioned working template. Own tables only; prospects only through Obchod's
 * scoped context, hotels only through HotelsService. Never Finance, never automatic.
 */
@Module({
  imports: [SalesModule, CustomersModule],
  controllers: [ContractDraftsController],
  providers: [ContractDraftsService],
})
export class ContractsModule {}
