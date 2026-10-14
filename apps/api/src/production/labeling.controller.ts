import {
  labelScanRequestSchema,
  scanRequestSchema,
  setLabelingContextRequestSchema,
  type LabelingOptions,
  type LabelingState,
  type LabelScanRequest,
  type LabelScanResult,
  type ScanRequest,
  type SetLabelingContextRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Authenticated } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { LabelingService } from './labeling.service.js';

const SESSION = new ParseUUIDPipe();

/**
 * The labelling station (doc 025 A3). `@Authenticated()`: every request re-validates the stored
 * station of the caller's own session (mode permission production:label_apply, active site,
 * PRODUCTION capability, warehouse) — never a station, product or crate named in the request
 * beyond what is checked against the session.
 */
@Controller(`${ADMIN_PREFIX}/station-sessions/:id`)
export class LabelingController {
  constructor(private readonly labeling: LabelingService) {}

  @Authenticated()
  @Get('labeling-options')
  options(
    @Param('id', SESSION) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LabelingOptions> {
    return this.labeling.options(principal, id);
  }

  @Authenticated()
  @Get('labeling')
  state(
    @Param('id', SESSION) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LabelingState> {
    return this.labeling.state(principal, id);
  }

  @Authenticated()
  @Post('labeling-context')
  @HttpCode(200)
  setContext(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(setLabelingContextRequestSchema)) body: SetLabelingContextRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LabelingState> {
    return this.labeling.setContext(principal, id, body);
  }

  @Authenticated()
  @Post('crate')
  @HttpCode(200)
  loadCrate(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(scanRequestSchema)) body: ScanRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LabelingState> {
    return this.labeling.loadCrate(principal, id, body);
  }

  /** "Potvrdit nalepení": 200 for APPLIED / ALREADY_APPLIED; 4xx with a stable code otherwise. */
  @Authenticated()
  @Post('label-scans')
  @HttpCode(200)
  scan(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(labelScanRequestSchema)) body: LabelScanRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LabelScanResult> {
    return this.labeling.scan(principal, id, body);
  }
}
