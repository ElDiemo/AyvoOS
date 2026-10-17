import { Module } from '@nestjs/common';
import { HotelsController } from './hotels.controller.js';
import { HotelsService } from './hotels.service.js';

/**
 * customers module (doc 007, doc 028): hotels — one delivery address, contact and the fulfilment
 * site. No contracts, billing or hotel users yet.
 */
@Module({
  controllers: [HotelsController],
  providers: [HotelsService],
  exports: [HotelsService],
})
export class CustomersModule {}
