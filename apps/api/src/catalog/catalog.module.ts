import { Module } from '@nestjs/common';
import { CratesModule } from '../crates/crates.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { ProductLabelApprovalsService } from './product-label-approvals.service.js';
import { RecipesService } from './recipes.service.js';

/**
 * catalog module (doc 023, doc 020 §2): company-wide components, product categories, products and
 * their versioned recipes (the BOM of one finished bottle, stored in the inventory module's BOM
 * tables), and the read-only material calculation. Uses inventory (items, units, BOMs) and crates
 * (crate types); never touches stock.
 */
@Module({
  imports: [InventoryModule, CratesModule, LabelsModule],
  controllers: [CatalogController],
  providers: [CatalogService, RecipesService, ProductLabelApprovalsService],
  exports: [RecipesService, ProductLabelApprovalsService],
})
export class CatalogModule {}
