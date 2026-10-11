import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LabelProductionModule } from '../label-production/label-production.module.js';
import { ProcurementModule } from '../procurement/procurement.module.js';
import { LabelApplicationService } from './label-application.service.js';
import { WarehouseController } from './warehouse.controller.js';
import { WarehouseReadService } from './warehouse-read.service.js';

/**
 * warehouse module (doc 018): physical label application (the scan that turns one new bottle
 * from stock into a labelled serialized bottle) and the read models of the warehouse screens.
 * Uses assets, label-production, inventory and procurement only through their services.
 */
@Module({
  imports: [AssetsModule, LabelProductionModule, InventoryModule, ProcurementModule],
  controllers: [WarehouseController],
  providers: [LabelApplicationService, WarehouseReadService],
})
export class WarehouseModule {}
