import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { LabelProductionModule } from './label-production/label-production.module.js';
import { LabelsModule } from './labels/labels.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.module.js';

/**
 * Root of the modular monolith (ADR 0001). Domain modules talk only through exported services:
 * labels ← assets ← label-production (see docs/016-bottles-and-labels.md).
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
  ],
})
export class AppModule {}
