import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AccountingExportsService } from './accounting-exports.service.js';
import { BankController } from './bank.controller.js';
import { BankSyncService } from './bank-sync.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceDocumentsService } from './finance-documents.service.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinanceHealthController } from './finance-health.controller.js';
import { FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

/**
 * The Finance feature (doc 039): received documents (N1), the export for the accountant (N2) and
 * the bank transactions read from RB Premium API (N3B-1, doc 041). Runs only in the Finance unit
 * (FinanceAppModule, ADR 0039) — never inside the core API. Owns schema `finance`; everything
 * of the core comes through CoreClient. Company-wide (no site); FINANCE stays a planned role.
 */
@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [FINANCE_ENV],
      useFactory: (env: FinanceEnv) => ({
        // In memory (bounded); validated by content.
        limits: { fileSize: env.FINANCE_DOCUMENT_MAX_BYTES, files: 1, fields: 20, parts: 21 },
      }),
    }),
  ],
  controllers: [FinanceController, BankController, FinanceHealthController],
  providers: [
    FinanceDocumentsService,
    AccountingExportsService,
    BankSyncService,
    FinancePrismaService,
    FinanceOperations,
  ],
})
export class FinanceModule {}
