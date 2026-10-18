import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { ENV, type Env } from '../config/env.js';
import { SitesModule } from '../sites/sites.module.js';
import { CARRIERS, type CarrierRegistry } from './carriers/carrier.js';
import { TestCarrier } from './carriers/test-carrier.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';

/**
 * orders module (doc 028, doc 029): manual orders, the picking of finished crates and their
 * dispatch to a carrier (shipment, parcels, labels, ready for pickup, handed over). Uses customers
 * (hotels), crates (cycles) and catalog (crate unit, weights) only through their exported
 * services. No stock movement and no delivery.
 */
@Module({
  imports: [CustomersModule, CratesModule, CatalogModule, LabelsModule, SitesModule],
  controllers: [OrdersController, ShipmentsController],
  providers: [
    OrdersService,
    ShipmentsService,
    {
      // The carrier per site (doc 022 §8). None until a real adapter is configured; the fake
      // TestCarrier exists only with APP_ENV=test (enforced by the environment schema).
      provide: CARRIERS,
      inject: [ENV],
      useFactory: (env: Env): CarrierRegistry => {
        const carrier = env.CARRIER_PROVIDER === 'test' ? new TestCarrier() : null;
        return { forSite: () => carrier };
      },
    },
  ],
})
export class OrdersModule {}
