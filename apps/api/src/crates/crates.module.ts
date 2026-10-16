import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module.js';
import { CrateCyclesService } from './crate-cycles.service.js';
import { CrateLabelPrintJobsService } from './crate-label-print-jobs.service.js';
import { CratePassportController } from './crate-passport.controller.js';
import { CrateTypesService } from './crate-types.service.js';
import { CratesController } from './crates.controller.js';
import { CratesService } from './crates.service.js';

/**
 * crates module (doc 020 §2): crate types (catalogue routes, doc 023), physical crates, their QR
 * labels and history (doc 025 A1). Crate cycles and assignments come with filling (doc 025 §9).
 * Uses the labels engine only through its exported renderer.
 */
@Module({
  imports: [LabelsModule],
  controllers: [CratesController, CratePassportController],
  providers: [CrateTypesService, CratesService, CrateLabelPrintJobsService, CrateCyclesService],
  exports: [CrateTypesService, CratesService, CrateCyclesService],
})
export class CratesModule {}
