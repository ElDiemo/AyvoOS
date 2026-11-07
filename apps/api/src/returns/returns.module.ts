import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CratesModule } from '../crates/crates.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { AfterWashService } from './after-wash.service.js';
import { ReturnReceiptsService } from './return-receipts.service.js';
import { ReturnsController } from './returns.controller.js';

/**
 * returns module — the return intake R1 (doc 047 §4): receipts, lines, issues and defective pump
 * counts — and R2 "Po mytí" (doc 048 §2). Bottles (assets), crate cycles (crates), allocations
 * (orders), hotels (customers) and design approvals (catalog) only through their exported
 * services. No stock movement, no placement into a crate and no refilling (R3).
 */
@Module({
  imports: [AssetsModule, CatalogModule, CratesModule, CustomersModule, OrdersModule],
  controllers: [ReturnsController],
  providers: [ReturnReceiptsService, AfterWashService],
})
export class ReturnsModule {}
