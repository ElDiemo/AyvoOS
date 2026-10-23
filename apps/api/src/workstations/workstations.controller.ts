import {
  CRATE_LABEL_SIZE_MM,
  createWorkstationRequestSchema,
  currentStationSessionSchema,
  openStationSessionRequestSchema,
  releaseStationSessionRequestSchema,
  takeoverStationSessionRequestSchema,
  workstationCodeSchema,
  workstationStatusChangeRequestSchema,
  type CreateWorkstationRequest,
  type CurrentStationSession,
  type ManagedWorkstation,
  type OpenStationSessionRequest,
  type StationSession,
  type StationSessionResult,
  type TakeoverStationSessionRequest,
  type WorkstationStatusChangeRequest,
} from '@ayvo/types';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import { qrBaseUrlViolation } from '../common/qr-policy.js';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { Authenticated, RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { CodeLabelRenderer } from '../labels/code-label-pdf.js';
import { assertCodeLabelLayout, requireQrLabelSettings } from '../labels/qr-label-settings.js';
import { StationSessionsService } from './station-sessions.service.js';
import { WorkstationsService } from './workstations.service.js';

const CODE = new ZodValidationPipe(workstationCodeSchema);
const sizeMm = z.coerce.number().int().min(CRATE_LABEL_SIZE_MM.min).max(CRATE_LABEL_SIZE_MM.max);
const labelQuerySchema = z.object({ widthMm: sizeMm, heightMm: sizeMm });
const MODE_LABEL = { LABELING: 'LEPENI', FILLING: 'PLNENI' } as const;

/** Výroba → Správa pracovišť (doc 026): stations of the active site. */
@Controller(`${ADMIN_PREFIX}/workstations`)
export class WorkstationsController {
  constructor(
    private readonly stations: WorkstationsService,
    private readonly renderer: CodeLabelRenderer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @RequirePermission('production:workstations_manage')
  @Get()
  list(@OperationalSite() site: SiteContext): Promise<ManagedWorkstation[]> {
    return this.stations.list(site.siteId);
  }

  @RequirePermission('production:workstations_manage')
  @Post()
  create(
    @Body(new ZodValidationPipe(createWorkstationRequestSchema)) body: CreateWorkstationRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ManagedWorkstation> {
    return this.stations.create(principal.userId, body, site);
  }

  @RequirePermission('production:workstations_manage')
  @Post(':code/deactivate')
  @HttpCode(200)
  deactivate(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(workstationStatusChangeRequestSchema))
    body: WorkstationStatusChangeRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ManagedWorkstation> {
    return this.stations.setStatus(principal.userId, code, 'INACTIVE', body, site.siteId);
  }

  @RequirePermission('production:workstations_manage')
  @Post(':code/reactivate')
  @HttpCode(200)
  reactivate(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(workstationStatusChangeRequestSchema))
    body: WorkstationStatusChangeRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<ManagedWorkstation> {
    return this.stations.setStatus(principal.userId, code, 'ACTIVE', body, site.siteId);
  }

  /**
   * The station's QR label as a PDF at the chosen size (not physically approved). The QR encodes
   * only the station's stable URL; nothing is recorded (the station QR is not a secret).
   */
  @RequirePermission('production:workstations_manage')
  @Get(':code/qr-label')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async label(
    @Param('code', CODE) code: string,
    @Query(new ZodValidationPipe(labelQuerySchema)) query: z.infer<typeof labelQuerySchema>,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    const violation = qrBaseUrlViolation(this.env.APP_ENV, this.env.PUBLIC_QR_BASE_URL);
    if (violation) throw new ForbiddenException(violation);
    const settings = requireQrLabelSettings(this.env);
    assertCodeLabelLayout(settings, query.widthMm, query.heightMm);
    const station = await this.stations.findOfSite(code, site.siteId);
    const bytes = Buffer.from(
      await this.renderer.render({
        title: `Workstation ${station.code}`,
        widthMm: query.widthMm,
        heightMm: query.heightMm,
        labels: [
          {
            code: station.code,
            detail: `${MODE_LABEL[station.mode]}${station.categoryCode ? ` · ${station.categoryCode}` : ''}`,
            url: this.stations.qrUrl(station.qrToken),
          },
        ],
        errorCorrection: settings.errorCorrection,
        devMarker: this.env.APP_ENV !== 'production',
      }),
    );
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: `attachment; filename="workstation_${station.code}_${query.widthMm}x${query.heightMm}mm.pdf"`,
      length: bytes.length,
    });
  }
}

/**
 * Station work (doc 026). `@Authenticated()`: the permission depends on the scanned/stored
 * station (its mode), so the service checks it — together with the active site and warehouse —
 * on every request (workstation-access.ts).
 */
@Controller(`${ADMIN_PREFIX}/station-sessions`)
export class StationSessionsController {
  constructor(private readonly sessions: StationSessionsService) {}

  @Authenticated()
  @Post()
  open(
    @Body(new ZodValidationPipe(openStationSessionRequestSchema)) body: OpenStationSessionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StationSessionResult> {
    return this.sessions.open(principal, body);
  }

  @Authenticated()
  @Get('current')
  async current(@CurrentPrincipal() principal: Principal): Promise<CurrentStationSession> {
    return currentStationSessionSchema.parse(await this.sessions.current(principal));
  }

  @Authenticated()
  @Post(':id/heartbeat')
  @HttpCode(200)
  heartbeat(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StationSession> {
    return this.sessions.heartbeat(principal, id);
  }

  @Authenticated()
  @Post(':id/release')
  @HttpCode(200)
  async release(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(releaseStationSessionRequestSchema)) body: { requestId: string },
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ status: 'RELEASED' }> {
    await this.sessions.release(principal, id, body.requestId);
    return { status: 'RELEASED' };
  }

  @Authenticated()
  @Post(':id/takeover')
  takeover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(takeoverStationSessionRequestSchema))
    body: TakeoverStationSessionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StationSessionResult> {
    return this.sessions.takeover(principal, id, body);
  }
}
