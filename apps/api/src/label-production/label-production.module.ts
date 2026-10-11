import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { BottleRegistrationService } from './bottle-registration.service.js';
import { LabelPrintJobsService } from './label-print-jobs.service.js';
import { LabelProductionController } from './label-production.controller.js';

/**
 * label-production module: the bottle registration workflow and label print jobs (PDF output).
 * Depends on assets (bottles) and labels (template versions) through their exported services.
 */
@Module({
  imports: [AssetsModule, LabelsModule],
  controllers: [LabelProductionController],
  providers: [BottleRegistrationService, LabelPrintJobsService],
  exports: [LabelPrintJobsService],
})
export class LabelProductionModule {}
