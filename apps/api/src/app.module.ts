import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { LabelProductionModule } from './label-production/label-production.module.js';
import { LabelsModule } from './labels/labels.module.js';
import { ProcurementModule } from './procurement/procurement.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.module.js';
import { WarehouseModule } from './warehouse/warehouse.module.js';

/**
 * Root of the modular monolith (ADR 0001). Domain modules talk only through exported services:
 * labels ← assets ← label-production (doc 016); inventory ← procurement; warehouse uses assets,
 * label-production, inventory and procurement (doc 018).
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    StorageModule,
    HealthModule,
    LabelsModule,
    AssetsModule,
    LabelProductionModule,
    InventoryModule,
    ProcurementModule,
    WarehouseModule,
  ],
})
export class AppModule {}
