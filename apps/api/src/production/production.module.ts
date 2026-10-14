import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LabelProductionModule } from '../label-production/label-production.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { WorkstationsModule } from '../workstations/workstations.module.js';
import { LabelingController } from './labeling.controller.js';
import { LabelingService } from './labeling.service.js';

/**
 * production module (doc 020 §2, doc 025): the station work that turns stock into identified
 * products — A3 labelling into crates; filling (A4) follows. Composes workstations, crates,
 * assets, catalog, label-production and inventory only through their exported services.
 */
@Module({
  imports: [
    WorkstationsModule,
    CratesModule,
    AssetsModule,
    CatalogModule,
    LabelProductionModule,
    LabelsModule,
    InventoryModule,
  ],
  controllers: [LabelingController],
  providers: [LabelingService],
})
export class ProductionModule {}
