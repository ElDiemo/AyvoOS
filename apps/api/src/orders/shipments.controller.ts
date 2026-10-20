import {
  abandonLabelsRequestSchema,
  cancelPrintJobRequestSchema,
  printJobCodeSchema,
  printShipmentRequestSchema,
  reprintParcelRequestSchema,
  retryLabelVariantRequestSchema,
  type CancelPrintJobRequest,
  type PrintShipmentRequest,
  type ReprintParcelRequest,
  type RetryLabelVariantRequest,
  cancelShipmentRequestSchema,
  resolveCancelRequestSchema,
  type AbandonLabelsRequest,
  type ResolveCancelRequest,
  handOverRequestSchema,
  refreshTrackingRequestSchema,
  type RefreshTrackingRequest,
  orderCodeSchema,
  readyForPickupRequestSchema,
  requestLabelsRequestSchema,
  resolveLabelsRequestSchema,
  weighParcelRequestSchema,
  type CancelShipmentRequest,
  type HandOverRequest,
  type OrderShipment,
  type ReadyForPickupRequest,
  type RequestLabelsRequest,
  type ResolveLabelsRequest,
  type WeighParcelRequest,
} from '@ayvo/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { ShipmentsService } from './shipments.service.js';

const CODE = new ZodValidationPipe(orderCodeSchema);

/**
 * Expedice — dispatch of an order to a carrier (doc 029): always through the order (there is no
 * separate shipment list and no manual creation). The active site and the current permissions
 * are checked on every read, write and repetition.
 */
@Controller(`${ADMIN_PREFIX}/orders/:code/shipment`)
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @RequirePermission('shipments:read')
  @Get()
  view(
    @Param('code', CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.view(site, code);
  }

  /** The complete label document (opening or downloading it is not evidence of printing). */
  @RequirePermission('shipments:read')
  @Get('labels')
  async labels(
    @Param('code', CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    return labelResponse(await this.shipments.labelFile(site, code, null));
  }

  /** One parcel's own label — the label of exactly that crate. */
  @RequirePermission('shipments:read')
  @Get('parcels/:parcelNo/label')
  async parcelLabel(
    @Param('code', CODE) code: string,
    @Param('parcelNo', ParseIntPipe) parcelNo: number,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    return labelResponse(await this.shipments.labelFile(site, code, parcelNo));
  }

  /** One parcel's ZPL for the printer — only for those who may print (doc 030 §7). */
  @RequirePermission('shipments:read', 'printing:print')
  @Get('parcels/:parcelNo/label/zpl')
  async parcelZpl(
    @Param('code', CODE) code: string,
    @Param('parcelNo', ParseIntPipe) parcelNo: number,
    @OperationalSite() site: SiteContext,
  ): Promise<StreamableFile> {
    return labelResponse(await this.shipments.labelFile(site, code, parcelNo, 'ZPL'));
  }

  /** "Tisknout štítky": every parcel label on the printer the operator saw (doc 030 §4). */
  @RequirePermission('printing:print')
  @Post('print')
  @HttpCode(200)
  print(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(printShipmentRequestSchema)) body: PrintShipmentRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.print(principal.userId, site, code, body);
  }

  /** "Vytisknout znovu" — one parcel label, explicit and audited. */
  @RequirePermission('printing:reprint')
  @Post('parcels/:parcelNo/reprint')
  @HttpCode(200)
  reprint(
    @Param('code', CODE) code: string,
    @Param('parcelNo', ParseIntPipe) parcelNo: number,
    @Body(new ZodValidationPipe(reprintParcelRequestSchema)) body: ReprintParcelRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.reprint(principal.userId, site, code, parcelNo, body);
  }

  /** "Získat ZPL znovu": the printer's labels fetched again from the carrier (same shipment). */
  @RequirePermission('shipments:prepare')
  @Post('zpl/retry')
  @HttpCode(200)
  retryLabelVariant(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(retryLabelVariantRequestSchema)) body: RetryLabelVariantRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.retryLabelVariant(principal.userId, site, code, body);
  }

  @RequirePermission('printing:print')
  @Post('print-jobs/:job/cancel')
  @HttpCode(200)
  cancelPrintJob(
    @Param('code', CODE) code: string,
    @Param('job', new ZodValidationPipe(printJobCodeSchema)) job: string,
    @Body(new ZodValidationPipe(cancelPrintJobRequestSchema)) body: CancelPrintJobRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.cancelPrintJob(principal.userId, site, code, job, body);
  }

  @RequirePermission('shipments:prepare')
  @Post('labels')
  @HttpCode(200)
  requestLabels(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(requestLabelsRequestSchema)) body: RequestLabelsRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.requestLabels(principal.userId, site, code, body);
  }

  @RequirePermission('shipments:prepare')
  @Post('resolve')
  @HttpCode(200)
  resolve(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(resolveLabelsRequestSchema)) body: ResolveLabelsRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.resolve(principal.userId, site, code, body);
  }

  /** Exceptional manual resolution of an uncertain request (separate permission, reason). */
  @RequirePermission('shipments:resolve_uncertain')
  @Post('abandon')
  @HttpCode(200)
  abandon(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(abandonLabelsRequestSchema)) body: AbandonLabelsRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.abandon(principal.userId, site, code, body);
  }

  @RequirePermission('shipments:prepare')
  @Post('cancel/resolve')
  @HttpCode(200)
  resolveCancel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(resolveCancelRequestSchema)) body: ResolveCancelRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.resolveCancel(principal.userId, site, code, body);
  }

  @RequirePermission('shipments:prepare')
  @Post('parcels/:parcelNo/weighings')
  @HttpCode(200)
  weigh(
    @Param('code', CODE) code: string,
    @Param('parcelNo', ParseIntPipe) parcelNo: number,
    @Body(new ZodValidationPipe(weighParcelRequestSchema)) body: WeighParcelRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.weigh(principal.userId, site, code, parcelNo, body);
  }

  @RequirePermission('shipments:prepare')
  @Post('ready')
  @HttpCode(200)
  ready(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(readyForPickupRequestSchema)) body: ReadyForPickupRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.readyForPickup(principal.userId, site, code, body);
  }

  @RequirePermission('shipments:handover')
  @Post('hand-over')
  @HttpCode(200)
  handOver(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(handOverRequestSchema)) body: HandOverRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.handOver(principal.userId, site, code, body);
  }

  /** "Obnovit tracking" (doc 031): those who confirm the hand-over may ask the carrier now. */
  @RequirePermission('shipments:handover')
  @Post('tracking/refresh')
  @HttpCode(200)
  refreshTracking(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(refreshTrackingRequestSchema)) _body: RefreshTrackingRequest,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.refreshTracking(site, code);
  }

  @RequirePermission('shipments:prepare')
  @Post('cancel')
  @HttpCode(200)
  cancel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(cancelShipmentRequestSchema)) body: CancelShipmentRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.shipments.cancel(principal.userId, site, code, body);
  }
}

function labelResponse(file: { bytes: Buffer; filename: string; format: string }): StreamableFile {
  return new StreamableFile(file.bytes, {
    type: file.format === 'ZPL' ? 'application/zpl' : 'application/pdf',
    disposition: `${file.format === 'ZPL' ? 'attachment' : 'inline'}; filename="${file.filename}"`,
  });
}
