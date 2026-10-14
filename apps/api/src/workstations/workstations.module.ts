import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LabelsModule } from '../labels/labels.module.js';
import { StationSessionsService } from './station-sessions.service.js';
import { WorkstationPassportController } from './workstation-passport.controller.js';
import { StationSessionsController, WorkstationsController } from './workstations.controller.js';
import { WorkstationsService } from './workstations.service.js';

/**
 * workstations module (doc 026, A2): stations as work modes at a site, their QR labels and the
 * work sessions at them. Exports the session check that labelling (A3) and filling (A4) build on.
 */
@Module({
  imports: [InventoryModule, LabelsModule],
  controllers: [WorkstationsController, StationSessionsController, WorkstationPassportController],
  providers: [WorkstationsService, StationSessionsService],
  exports: [StationSessionsService],
})
export class WorkstationsModule {}
