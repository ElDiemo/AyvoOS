import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { SitesModule } from '../sites/sites.module.js';
import { CarriersModule } from '../carriers/carriers.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentCarrierFlow } from './shipment-carrier-flow.service.js';
import { ShipmentDeriver } from './shipment-deriver.service.js';
import { ShipmentPoller } from './shipment-poller.service.js';
import { ShipmentsService } from './shipments.service.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';
import { SupplyPlanRunner } from './supply-plan-runner.service.js';
import { SupplyPlansController } from './supply-plans.controller.js';
import { SupplyPlansService } from './supply-plans.service.js';

/**
 * orders module (doc 028, doc 029): manual orders, the picking of finished crates and their
 * dispatch to a carrier (shipment, parcels, labels, ready for pickup, handed over). Uses customers
 * (hotels), crates (cycles) and catalog (crate unit, weights) only through their exported
 * services. No stock movement. Delivery only as the carrier's tracking proves it (doc 031) — no
 * returns, no hotel portal.
 */
@Module({
  imports: [
    CustomersModule,
    CratesModule,
    CatalogModule,
    LabelsModule,
    SitesModule,
    CarriersModule,
    PrintingModule,
  ],
  controllers: [OrdersController, ShipmentsController, SupplyPlansController],
  providers: [
    OrdersService,
    ShipmentsService,
    ShipmentDeriver,
    ShipmentCarrierFlow,
    ShipmentPoller,
    ShipmentTrackingService,
    SupplyPlansService,
    SupplyPlanRunner,
  ],
})
export class OrdersModule {}
