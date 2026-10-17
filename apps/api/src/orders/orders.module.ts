import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { SitesModule } from '../sites/sites.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/**
 * orders module (doc 028): manual orders and the picking of finished crates. Uses customers
 * (hotels), crates (cycles) and catalog (the product's crate unit) only through their exported
 * services. No stock movement, carrier, dispatch or delivery.
 */
@Module({
  imports: [CustomersModule, CratesModule, CatalogModule, LabelsModule, SitesModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
