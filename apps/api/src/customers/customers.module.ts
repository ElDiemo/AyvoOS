import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module.js';
import { HotelsController } from './hotels.controller.js';
import { HotelsService } from './hotels.service.js';

/**
 * customers module (doc 007, doc 028): hotels — one delivery address, contact and the fulfilment
 * site. No contracts, billing or hotel users yet.
 */
@Module({
  imports: [SitesModule],
  controllers: [HotelsController],
  providers: [HotelsService],
  exports: [HotelsService],
})
export class CustomersModule {}
