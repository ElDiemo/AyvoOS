import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module.js';
import { BottlePassportController } from './bottle-passport.controller.js';
import { BottlesController } from './bottles.controller.js';
import { BottlesService } from './bottles.service.js';

/**
 * assets module: physical bottles (permanent identity + public QR token), their append-only
 * lifecycle events and creation batches. Uses the labels module only through its exported
 * service. Exports BottlesService for label-production.
 */
@Module({
  imports: [LabelsModule],
  controllers: [BottlesController, BottlePassportController],
  providers: [BottlesService],
  exports: [BottlesService],
})
export class AssetsModule {}
