import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { SitesController } from './sites.controller.js';
import { SiteDependencyRegistry } from './site-dependencies.js';
import { SitesService } from './sites.service.js';

/**
 * sites module (doc 022, ADR 0023): AYVO's physical facilities — the operational boundary that
 * warehouses (and later production, crates, returns, dispatch) belong to. Site access of users
 * is evaluated by the identity module's guard through SitesService.
 */
@Module({
  imports: [InventoryModule],
  controllers: [SitesController],
  providers: [SitesService, SiteDependencyRegistry],
  exports: [SitesService, SiteDependencyRegistry],
})
export class SitesModule {}
