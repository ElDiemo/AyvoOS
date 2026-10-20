import {
  cancelOrderRequestSchema,
  completeAndLabelRequestSchema,
  completeOrderRequestSchema,
  crateCodeSchema,
  createOrderRequestSchema,
  hotelCodeSchema,
  orderCodeSchema,
  orderScanRequestSchema,
  orderListQuerySchema,
  hotelOrdersQuerySchema,
  removeOrderCrateRequestSchema,
  type CancelOrderRequest,
  type CompleteAndLabelRequest,
  type CompleteOrderRequest,
  type OrderShipment,
  type CreateOrderRequest,
  type HotelSummary,
  type OrderableProduct,
  type OrderDetail,
  type OrderList,
  type OrderScanRequest,
  type OrderScanResult,
  type HotelOrders,
  type HotelOrdersQuery,
  type OrderCalendar,
  type OrderListQuery,
  type RemoveOrderCrateRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { OrdersService } from './orders.service.js';

const CODE = new ZodValidationPipe(orderCodeSchema);

/**
 * Objednávky a expedice (doc 028): orders of the active site and their picking. An order of
 * another site is not found; nothing here is a dispatch or a delivery.
 */
@Controller(`${ADMIN_PREFIX}/orders`)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermission('orders:read')
  @Get()
  list(
    @Query(new ZodValidationPipe(orderListQuerySchema)) query: OrderListQuery,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderList> {
    return this.orders.list(site, query);
  }

  @RequirePermission('orders:read')
  @Get('calendar')
  calendar(@OperationalSite() site: SiteContext): Promise<OrderCalendar> {
    return this.orders.calendar(site);
  }

  @RequirePermission('orders:manage')
  @Get('products')
  products(): Promise<OrderableProduct[]> {
    return this.orders.orderableProducts();
  }

  @RequirePermission('orders:manage')
  @Get('hotels')
  hotels(@OperationalSite() site: SiteContext): Promise<HotelSummary[]> {
    return this.orders.hotelsServed(site);
  }

  @RequirePermission('orders:read')
  @Get('hotel/:hotel')
  ofHotel(
    @Param('hotel', new ZodValidationPipe(hotelCodeSchema)) hotel: string,
    @Query(new ZodValidationPipe(hotelOrdersQuerySchema)) query: HotelOrdersQuery,
    @OperationalSite() site: SiteContext,
  ): Promise<HotelOrders> {
    return this.orders.ofHotel(site, hotel, query);
  }

  @RequirePermission('orders:read')
  @Get(':code')
  detail(
    @Param('code', CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderDetail> {
    return this.orders.detail(site, code);
  }

  @RequirePermission('orders:manage')
  @Post()
  create(
    @Body(new ZodValidationPipe(createOrderRequestSchema)) body: CreateOrderRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderDetail> {
    return this.orders.create(principal.userId, site, body);
  }

  @RequirePermission('orders:pick')
  @Post(':code/crates')
  @HttpCode(200)
  addCrate(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(orderScanRequestSchema)) body: OrderScanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderScanResult> {
    return this.orders.addCrate(principal.userId, site, code, body);
  }

  @RequirePermission('orders:pick')
  @Post(':code/crates/:crate/remove')
  @HttpCode(200)
  removeCrate(
    @Param('code', CODE) code: string,
    @Param('crate', new ZodValidationPipe(crateCodeSchema)) crate: string,
    @Body(new ZodValidationPipe(removeOrderCrateRequestSchema)) body: RemoveOrderCrateRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderDetail> {
    return this.orders.removeCrate(principal.userId, site, code, crate, body);
  }

  @RequirePermission('orders:pick')
  @Post(':code/complete')
  @HttpCode(200)
  complete(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(completeOrderRequestSchema)) body: CompleteOrderRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderDetail> {
    return this.orders.complete(principal.userId, site, code, body);
  }

  /**
   * "Dokončit a vytisknout štítky" (doc 030 §1): completing the picking AND preparing the shipment
   * need both permissions; printing in it additionally printing:print (checked in the service).
   */
  @RequirePermission('orders:pick', 'shipments:prepare')
  @Post(':code/complete-and-label')
  @HttpCode(200)
  completeAndLabel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(completeAndLabelRequestSchema)) body: CompleteAndLabelRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderShipment> {
    return this.orders.completeAndLabel(principal, site, code, body);
  }

  @RequirePermission('orders:manage')
  @Post(':code/cancel')
  @HttpCode(200)
  cancel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(cancelOrderRequestSchema)) body: CancelOrderRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<OrderDetail> {
    return this.orders.cancel(principal.userId, site, code, body);
  }
}
