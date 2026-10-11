import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV, type Env } from '../config/env.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ProcurementController } from './procurement.controller.js';
import { ProcurementService } from './procurement.service.js';

/**
 * procurement module (doc 018): suppliers, supplier documents and confirmed goods receipts.
 * Depends on inventory (lots, ledger) through InventoryService. Purchase orders join later.
 */
@Module({
  imports: [
    InventoryModule,
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        // In memory (bounded); validated by content, then written under a server-generated key.
        limits: { fileSize: env.SUPPLIER_DOCUMENT_MAX_BYTES, files: 1, fields: 10, parts: 11 },
      }),
    }),
  ],
  controllers: [ProcurementController],
  providers: [ProcurementService],
  exports: [ProcurementService],
})
export class ProcurementModule {}
