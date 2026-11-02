import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AccountingExportsService } from './accounting-exports.service.js';
import { BillingSettingsController } from './billing-settings.controller.js';
import { BillingSettingsService } from './billing-settings.service.js';
import { InvoiceDeliveriesController } from './invoice-deliveries.controller.js';
import { InvoiceDeliveriesService } from './invoice-deliveries.service.js';
import { InvoiceDeliveryRunner } from './invoice-delivery-runner.service.js';
import { createInvoiceMailTransport, INVOICE_MAIL_TRANSPORT } from './invoice-mail-transport.js';
import { InvoicesController } from './invoices.controller.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { InvoicesService } from './invoices.service.js';
import { IssuerSettingsController } from './issuer-settings.controller.js';
import { IssuerSettingsService } from './issuer-settings.service.js';
import { BankController } from './bank.controller.js';
import { BankSyncService } from './bank-sync.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceDocumentsService } from './finance-documents.service.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinanceHealthController } from './finance-health.controller.js';
import { FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

/**
 * The Finance feature (doc 039, doc 040, doc 041): received documents (N1), the export for the
 * accountant (N2), hotel billing settings (N3A-1), our company with its invoice bank accounts
 * (N3A-2a) and the bank transactions read from RB Premium API (N3B-1). Runs only in the Finance unit
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
    InvoicesController,
    InvoiceDeliveriesController,
    PaymentsController,
    BankController,
    FinanceHealthController,
  ],
  providers: [
    FinanceDocumentsService,
    AccountingExportsService,
    BillingSettingsService,
    IssuerSettingsService,
    InvoicesService,
    InvoiceDeliveriesService,
    InvoiceDeliveryRunner,
    {
      provide: INVOICE_MAIL_TRANSPORT,
      inject: [FINANCE_ENV],
      useFactory: (env: FinanceEnv) => createInvoiceMailTransport(env),
    },
    PaymentsService,
    BankSyncService,
    FinancePrismaService,
    FinanceOperations,
  ],
})
export class FinanceModule {}
