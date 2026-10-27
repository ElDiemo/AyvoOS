import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { StockIssuesService } from './stock-issues.service.js';

/**
 * inventory module (doc 018): items, units, locations, lots, consumption rules, the stock ledger
 * and its protected balances. No controller: its screens are composed by the warehouse module.
 * Depends on no other domain module.
 */
@Module({
  providers: [InventoryService, StockIssuesService],
  exports: [InventoryService, StockIssuesService],
})
export class InventoryModule {}
