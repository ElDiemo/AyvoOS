import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ReturnReceiptsService } from './return-receipts.service.js';
import { ReturnsController } from './returns.controller.js';

/**
 * returns module — the return intake R1 (doc 047 §4): receipts, lines, issues and defective pump
 * counts. Bottles (assets), crate cycles (crates), allocations (orders) and hotels (customers)
 * only through their exported services. No stock movement, no washing (R2), no refilling (R3).
 */
@Module({
  imports: [AssetsModule, CratesModule, CustomersModule, OrdersModule],
  controllers: [ReturnsController],
  providers: [ReturnReceiptsService],
})
export class ReturnsModule {}
