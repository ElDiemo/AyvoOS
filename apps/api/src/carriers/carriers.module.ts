import { Module } from '@nestjs/common';
import { CARRIERS } from './carrier.js';
import { CarrierConnectionsController } from './carrier-connections.controller.js';
import { CarrierCredentialsService } from './carrier-credentials.service.js';
import { CarrierRegistryService } from './carrier-registry.service.js';
import { CarrierSettingsController } from './carrier-settings.controller.js';
import { CarrierSettingsService } from './carrier-settings.service.js';

/**
 * carriers module (doc 029 §4, §9): the carrier boundary, the per-site carrier settings (PPL),
 * the PPL CPL adapter and the server-side connections. Exports the registry (CARRIERS) used by the
 * orders module; credentials never leave the server process.
 */
@Module({
  controllers: [CarrierSettingsController, CarrierConnectionsController],
  providers: [
    CarrierRegistryService,
    { provide: CARRIERS, useExisting: CarrierRegistryService },
    CarrierSettingsService,
    CarrierCredentialsService,
  ],
  exports: [CARRIERS],
})
export class CarriersModule {}
