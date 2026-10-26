import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AccountingExportsService } from './accounting-exports.service.js';
import { BillingSettingsController } from './billing-settings.controller.js';
import { BillingSettingsService } from './billing-settings.service.js';
import { IssuerSettingsController } from './issuer-settings.controller.js';
import { IssuerSettingsService } from './issuer-settings.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceDocumentsService } from './finance-documents.service.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinanceHealthController } from './finance-health.controller.js';
import { FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

/**
 * The Finance feature (doc 039, doc 040): received documents (N1), the export for the accountant (N2)
 * hotel billing settings (N3A-1) and our company with its invoice bank accounts (N3A-2a). Runs only in the Finance unit
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
  controllers: [
    FinanceController,
    BillingSettingsController,
    IssuerSettingsController,
    FinanceHealthController,
  ],
  providers: [
    FinanceDocumentsService,
    AccountingExportsService,
    BillingSettingsService,
    IssuerSettingsService,
    FinancePrismaService,
    FinanceOperations,
  ],
})
export class FinanceModule {}
