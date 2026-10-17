import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ConfigModule } from './config/config.module.js';
import { CratesModule } from './crates/crates.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { WorkstationsModule } from './workstations/workstations.module.js';
import { ProductionModule } from './production/production.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { LabelProductionModule } from './label-production/label-production.module.js';
import { LabelsModule } from './labels/labels.module.js';
import { ProcurementModule } from './procurement/procurement.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SitesModule } from './sites/sites.module.js';
import { StorageModule } from './storage/storage.module.js';
import { WarehouseModule } from './warehouse/warehouse.module.js';

/**
 * Root of the modular monolith (ADR 0001). Domain modules talk only through exported services:
 * labels ← assets ← label-production (doc 016); inventory ← procurement; warehouse uses assets,
 * label-production, inventory and procurement (doc 018); sites (doc 022) owns the facilities that
 * warehouses belong to; catalog (doc 023) owns the company-wide product catalogue and recipes
 * (using inventory's items and BOMs and the crate types of crates); audit is the shared security
 * audit; identity (ADR 0022) registers the
 * global access guard — every route is denied unless it declares its access rule.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    StorageModule,
    HealthModule,
    AuditModule,
    SitesModule,
    IdentityModule,
    LabelsModule,
    AssetsModule,
    LabelProductionModule,
    InventoryModule,
    ProcurementModule,
    WarehouseModule,
    CratesModule,
    WorkstationsModule,
    ProductionModule,
    CatalogModule,
    CustomersModule,
    OrdersModule,
  ],
})
export class AppModule {}
