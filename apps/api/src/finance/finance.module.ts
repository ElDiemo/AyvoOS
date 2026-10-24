import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV, type Env } from '../config/env.js';
import { ProcurementModule } from '../procurement/procurement.module.js';
import { FinanceController } from './finance.controller.js';
import { AccountingExportsService } from './accounting-exports.service.js';
import { FinanceDocumentsService } from './finance-documents.service.js';

/**
 * finance module (doc 039): received documents (N1) and the accountant export (N2). Owns finance_* tables only; suppliers come
 * from ProcurementService. Company-wide (no site); FINANCE stays a planned role (doc 021 §4c).
 */
@Module({
  imports: [
    ProcurementModule,
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        // In memory (bounded, the same limit as supplier documents); validated by content.
        limits: { fileSize: env.SUPPLIER_DOCUMENT_MAX_BYTES, files: 1, fields: 20, parts: 21 },
      }),
    }),
  ],
  controllers: [FinanceController],
  providers: [FinanceDocumentsService, AccountingExportsService],
  exports: [FinanceDocumentsService],
})
export class FinanceModule {}
