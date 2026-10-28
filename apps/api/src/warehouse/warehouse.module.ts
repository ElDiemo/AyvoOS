import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LabelProductionModule } from '../label-production/label-production.module.js';
import { ProcurementModule } from '../procurement/procurement.module.js';
import { WarehouseController } from './warehouse.controller.js';
import { WarehouseReadService } from './warehouse-read.service.js';

/**
 * warehouse module (doc 018): the read models of the warehouse screens. Physical label
 * application moved to the labelling station (doc 025 A3, production module); the standalone
 * endpoint is retired (410).
 * Uses assets, catalog (pieces per roll of labels), label-production, inventory and procurement
 * only through their services.
 */
@Module({
  imports: [AssetsModule, CatalogModule, LabelProductionModule, InventoryModule, ProcurementModule],
  controllers: [WarehouseController],
  providers: [WarehouseReadService],
})
export class WarehouseModule {}
