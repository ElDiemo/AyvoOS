import type { BottleRegistrationResponse, CreateBottleRegistrationRequest } from '@ayvo/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
import { ENV, type Env } from '../config/env.js';
import { requireQrLabelSettings } from '../labels/qr-label-settings.js';
import { LabelPrintJobsService } from './label-print-jobs.service.js';

/**
 * Registration workflow "create bottles and prepare their labels" (idempotent per requestId):
 *   1. assets: create the batch, the bottles and their CREATED events (one transaction).
 *   2. label-production: create a PENDING print job for exactly those bottles (separate step).
 * Step 2 can fail without affecting step 1: the bottles stay registered and a print job can be
 * created from the batch page. PDF rendering is a further, separate step (generate).
 * Without the validated QR settings nothing is created at all (identities exist only to be
 * labelled): refused before step 1, so a retry after configuring creates everything once.
 */
@Injectable()
export class BottleRegistrationService {
  private readonly logger = new Logger(BottleRegistrationService.name);

  constructor(
    private readonly bottles: BottlesService,
    private readonly printJobs: LabelPrintJobsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Registers bottles at the active site (doc 022 §6); the series and bottles belong to it. */
  async register(
    request: CreateBottleRegistrationRequest,
    siteId: string,
  ): Promise<BottleRegistrationResponse> {
    requireQrLabelSettings(this.env);
    const { batch, replayed } = await this.bottles.createBatch({ ...request, siteId });
    try {
      // A replayed request returns the job prepared the first time (or completes the workflow
      // if that step had failed), so retries never multiply print jobs either.
      const previous = replayed
        ? (await this.printJobs.listForBatch(batch.code, siteId))[0]
        : undefined;
      const printJob = previous ?? (await this.printJobs.createForBatch(batch.code, siteId));
      return { replayed, batch, printJob };
    } catch (error) {
      this.logger.error(
        `Bottles of ${batch.code} were created, but the print job could not be created`,
        error instanceof Error ? error.stack : String(error),
      );
      return { replayed, batch, printJob: null };
    }
  }
}
