import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV, type Env } from '../config/env.js';
import { CustomersModule } from '../customers/customers.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { ContractDraftsController } from './contract-drafts.controller.js';
import { ContractDraftsService } from './contract-drafts.service.js';

/**
 * contracts module (ADR 0043, doc 045): contract drafts prepared by hand at a prospect or a hotel,
 * printed from a versioned working template, and the signed original kept in the private
 * FileStorage (namespace contract-documents). Own tables only; prospects only through Obchod's
 * scoped context, hotels only through HotelsService. Never Finance, never automatic.
 */
@Module({
  imports: [
    SalesModule,
    CustomersModule,
    // The signed original: in memory, at most the limit of supplier documents, one file.
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        limits: { fileSize: env.SUPPLIER_DOCUMENT_MAX_BYTES, files: 1, fields: 5, parts: 6 },
      }),
    }),
  ],
  controllers: [ContractDraftsController],
  providers: [ContractDraftsService],
  // The hotel portal reads a granted hotel's signed originals (never drafts).
  exports: [ContractDraftsService],
})
export class ContractsModule {}
