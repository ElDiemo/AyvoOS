import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { ENV, type Env } from '../config/env.js';
import { SitesModule } from '../sites/sites.module.js';
import { CARRIERS } from './carriers/carrier.js';
import { carrierRegistry } from './carriers/carrier-registry.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentCarrierFlow } from './shipment-carrier-flow.service.js';
import { ShipmentDeriver } from './shipment-deriver.service.js';
import { ShipmentPoller } from './shipment-poller.service.js';
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
    ShipmentDeriver,
    ShipmentCarrierFlow,
    ShipmentPoller,
    { provide: CARRIERS, inject: [ENV], useFactory: (env: Env) => carrierRegistry(env) },
  ],
})
export class OrdersModule {}
