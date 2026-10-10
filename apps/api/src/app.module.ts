import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';

/**
 * Root of the modular monolith (ADR 0001). Domain modules (catalog, assets,
 * production, warehouse, customers, ...) are added here as they are built.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, HealthModule],
})
export class AppModule {}
