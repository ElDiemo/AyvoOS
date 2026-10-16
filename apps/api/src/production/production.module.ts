import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LabelProductionModule } from '../label-production/label-production.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { WorkstationsModule } from '../workstations/workstations.module.js';
import { CrateContentController } from './crate-content.controller.js';
import { CrateContentService } from './crate-content.service.js';
import { CycleCorrectionsController } from './cycle-corrections.controller.js';
import { CycleCorrectionsService } from './cycle-corrections.service.js';
import { FillingController } from './filling.controller.js';
import { FillingService } from './filling.service.js';
import { LabelingController } from './labeling.controller.js';
import { LabelingService } from './labeling.service.js';
import { ReadinessController } from './readiness.controller.js';
import { ReadinessService } from './readiness.service.js';

/**
 * production module (doc 020 §2, doc 025): the station work that turns stock into identified
 * products — A3 labelling into crates, A4 filling, Hotovo and supervised crate corrections. Composes workstations, crates,
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
  controllers: [
    LabelingController,
    FillingController,
    CycleCorrectionsController,
    CrateContentController,
    ReadinessController,
  ],
  providers: [
    LabelingService,
    FillingService,
    CycleCorrectionsService,
    CrateContentService,
    ReadinessService,
  ],
})
export class ProductionModule {}
