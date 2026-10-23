import { Module } from '@nestjs/common';
import { ProspectsService } from './prospects.service.js';
import { SalesController } from './sales.controller.js';
import { SalesImportService } from './sales-import.service.js';
import { SalesViews } from './sales-views.js';
import { SalesWorkService } from './sales-work.service.js';

/**
 * sales module — Obchod: hotel acquisition (doc 034, ADR 0031). Own tables only; it reads and
 * writes nothing of other modules (prospects are not operational hotels).
 */
@Module({
  controllers: [SalesController],
  providers: [ProspectsService, SalesWorkService, SalesViews, SalesImportService],
})
export class SalesModule {}
