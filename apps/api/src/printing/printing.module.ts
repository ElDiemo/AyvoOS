import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller.js';
import { PrintAgentGuard } from './print-agent.guard.js';
import { PrintQueueService } from './print-queue.service.js';
import { PrintSweeper } from './print-sweeper.service.js';
import { PrintersService } from './printers.service.js';
import { PrintingController } from './printing.controller.js';

/**
 * printing module (doc 030, ADR 0028): printers and print agents per site, the durable print
 * queue and the print agent's API. The orders module hands it the stored labels to print; it never
 * reads the orders module's tables.
 */
@Module({
  controllers: [PrintingController, AgentController],
  providers: [PrintersService, PrintQueueService, PrintAgentGuard, PrintSweeper],
  exports: [PrintersService, PrintQueueService],
})
export class PrintingModule {}
