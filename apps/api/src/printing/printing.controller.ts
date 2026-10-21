import {
  createPrintAgentRequestSchema,
  revokePrintAgentRequestSchema,
  rotatePrintAgentRequestSchema,
  savePrinterRequestSchema,
  type CreatePrintAgentRequest,
  type PrintAgentToken,
  type RevokePrintAgentRequest,
  type RotatePrintAgentRequest,
  type SavePrinterRequest,
  type SitePrinting,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { PrintersService } from './printers.service.js';

/**
 * Správa systému → Provozovny → detail → Tiskárny (doc 030 §3): printers and print agents of a
 * site, ADMIN only (`printing:manage`, security administration). An agent's token is in the answer
 * of its creation or rotation only — never again.
 */
@Controller(`${ADMIN_PREFIX}/sites/:siteId/printing`)
export class PrintingController {
  constructor(private readonly printers: PrintersService) {}

  @RequirePermission('printing:manage')
  @Get()
  view(@Param('siteId', new ParseUUIDPipe()) siteId: string): Promise<SitePrinting> {
    return this.printers.view(siteId);
  }

  @RequirePermission('printing:manage')
  @Post('printers')
  @HttpCode(200)
  savePrinter(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body(new ZodValidationPipe(savePrinterRequestSchema)) body: SavePrinterRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SitePrinting> {
    return this.printers.savePrinter(principal.userId, siteId, body);
  }

  @RequirePermission('printing:manage')
  @Post('agents')
  @HttpCode(200)
  createAgent(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body(new ZodValidationPipe(createPrintAgentRequestSchema)) body: CreatePrintAgentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PrintAgentToken> {
    return this.printers.createAgent(principal.userId, siteId, body);
  }

  @RequirePermission('printing:manage')
  @Post('agents/:agentId/rotate')
  @HttpCode(200)
  rotateAgent(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('agentId', new ParseUUIDPipe()) agentId: string,
    @Body(new ZodValidationPipe(rotatePrintAgentRequestSchema)) body: RotatePrintAgentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PrintAgentToken> {
    return this.printers.rotateAgent(principal.userId, siteId, agentId, body);
  }

  @RequirePermission('printing:manage')
  @Post('agents/:agentId/revoke')
  @HttpCode(200)
  revokeAgent(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('agentId', new ParseUUIDPipe()) agentId: string,
    @Body(new ZodValidationPipe(revokePrintAgentRequestSchema)) body: RevokePrintAgentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SitePrinting> {
    return this.printers.revokeAgent(principal.userId, siteId, agentId, body);
  }
}
