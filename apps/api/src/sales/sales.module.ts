import { Module } from '@nestjs/common';
import { ProspectContextService } from './prospect-context.service.js';
import { ProspectsService } from './prospects.service.js';
import { SalesController } from './sales.controller.js';
import { SalesImportService } from './sales-import.service.js';
import { SalesResultsService } from './sales-results.service.js';
import { SalesViews } from './sales-views.js';
import { SalesWorkService } from './sales-work.service.js';
import { SalespeopleService } from './salespeople.service.js';

/**
 * sales module — Obchod: hotel acquisition (doc 034, ADR 0031). Own tables only; it reads and
 * writes nothing of other modules (prospects are not operational hotels). It exports only the
 * scoped, read-only prospect context (contract drafts, ADR 0043) and who is a salesperson
 * (commissions, doc 068).
 */
@Module({
  controllers: [SalesController],
  providers: [
    ProspectsService,
    SalesWorkService,
    SalesViews,
    SalesImportService,
    SalesResultsService,
    ProspectContextService,
    SalespeopleService,
  ],
  exports: [ProspectContextService, SalespeopleService],
})
export class SalesModule {}
