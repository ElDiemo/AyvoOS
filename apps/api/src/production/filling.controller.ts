import {
  finishCrateRequestSchema,
  labelScanRequestSchema,
  scanRequestSchema,
  setLiquidLotRequestSchema,
  type FillingState,
  type FillScanResult,
  type FinishCrateRequest,
  type FinishCrateResult,
  type LabelScanRequest,
  type ScanRequest,
  type SetLiquidLotRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Authenticated } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { FillingService } from './filling.service.js';

const SESSION = new ParseUUIDPipe();

/**
 * The filling station (doc 025 A4). `@Authenticated()`: every request — a replay included —
 * re-validates the stored station of the caller's own session (mode permission production:fill,
 * active site, PRODUCTION capability, warehouse); crate, lot and bottle are checked against it.
 */
@Controller(`${ADMIN_PREFIX}/station-sessions/:id`)
export class FillingController {
  constructor(private readonly filling: FillingService) {}

  @Authenticated()
  @Get('filling')
  state(
    @Param('id', SESSION) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FillingState> {
    return this.filling.state(principal, id);
  }

  @Authenticated()
  @Post('filling-crate')
  @HttpCode(200)
  loadCrate(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(scanRequestSchema)) body: ScanRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FillingState> {
    return this.filling.loadCrate(principal, id, body);
  }

  @Authenticated()
  @Post('liquid-lot')
  @HttpCode(200)
  setLiquidLot(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(setLiquidLotRequestSchema)) body: SetLiquidLotRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FillingState> {
    return this.filling.setLiquidLot(principal, id, body);
  }

  /** "Potvrdit naplnění": 200 for FILLED / ALREADY_FILLED; 4xx with a stable code otherwise. */
  @Authenticated()
  @Post('fill-scans')
  @HttpCode(200)
  scan(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(labelScanRequestSchema)) body: LabelScanRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FillScanResult> {
    return this.filling.scan(principal, id, body);
  }

  /** Hotovo. */
  @Authenticated()
  @Post('finish')
  @HttpCode(200)
  finish(
    @Param('id', SESSION) id: string,
    @Body(new ZodValidationPipe(finishCrateRequestSchema)) body: FinishCrateRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FinishCrateResult> {
    return this.filling.finish(principal, id, body);
  }
}
