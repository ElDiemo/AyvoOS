import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { ItemBarcodesService } from './item-barcodes.service.js';

/**
 * inventory module (doc 018): items, units, locations, lots, consumption rules, the stock ledger
 * and its protected balances, goods barcodes of items (doc 033). No controller: its screens are composed by the warehouse module.
 * Depends on no other domain module.
 */
@Module({
  providers: [InventoryService, ItemBarcodesService],
  exports: [InventoryService, ItemBarcodesService],
})
export class InventoryModule {}
