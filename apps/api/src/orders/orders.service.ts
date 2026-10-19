import type {
  OrderStatus,
  CancelOrderRequest,
  CompleteOrderRequest,
  CreateOrderRequest,
  HotelOrders,
  HotelOrdersQuery,
  HotelSummary,
  OrderCalendar,
  OrderListQuery,
  OrderableProduct,
  OrderDetail,
  OrderList,
  OrderScanRequest,
  OrderScanResult,
  OrderSummary,
  OrderView,
  RemoveOrderCrateRequest,
} from '@ayvo/types';
import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { RecipesService } from '../catalog/recipes.service.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { CrateCyclesService } from '../crates/crate-cycles.service.js';
import { HotelsService } from '../customers/hotels.service.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { QrRegistryService } from '../database/qr-registry.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';
import { lockSiteShared, SiteDependencyRegistry } from '../sites/site-dependencies.js';
import { ShipmentsService } from './shipments.service.js';

const summaryInclude = {
  hotel: { select: { code: true, name: true } },
  site: { select: { code: true, name: true } },
  lines: { select: { crates: true, capacity: true, allocatedCrates: true } },
} satisfies Prisma.OrderInclude;
type SummaryRecord = Prisma.OrderGetPayload<{ include: typeof summaryInclude }>;

const orderNotOpen = (status: string) =>
  domainErrorWithDetails(409, 'ORDER_NOT_OPEN', 'This order is not open for picking', { status });

/**
 * orders module (doc 028): manual orders of a hotel at its fulfilment site and the picking of
 * finished crates into them. Every operation acts at the session's active site (an order of
 * another site is not found), is idempotent per request id and runs in one transaction with the
 * lock order operation → order → crate → cycle. Picking consumes nothing from stock and changes
 * no bottle status; it ends at "Připraveno k expedici" (no carrier, dispatch or delivery).
 */
@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly hotels: HotelsService,
    private readonly cycles: CrateCyclesService,
    private readonly recipes: RecipesService,
    private readonly labels: LabelTemplatesService,
    private readonly registry: QrRegistryService,
    private readonly siteDependencies: SiteDependencyRegistry,
    private readonly shipments: ShipmentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A site with orders not yet handed to the carrier stays active: they could no longer be
   * picked, prepared or cancelled there (doc 022 §7, doc 029).
   */
  onModuleInit(): void {
    this.siteDependencies.register(async (siteId, db) => {
      const n = await db.order.count({
        where: { siteId, status: { in: ['OPEN', 'READY_TO_DISPATCH', 'READY_FOR_PICKUP'] } },
      });
      return n > 0
        ? [{ code: 'ORDERS_NOT_CLOSED', detail: `${n} order(s) are not yet handed over` }]
        : [];
    });
  }

  /** The active site's calendar day: the form's default and minimum (same rule as the API). */
  async calendar(site: SiteContext): Promise<OrderCalendar> {
    const row = await this.prisma.site.findUniqueOrThrow({
      where: { id: site.siteId },
      select: { code: true, name: true, timeZone: true },
    });
    return {
      today: localDate(new Date(), row.timeZone),
      timeZone: row.timeZone,
      site: { code: row.code, name: row.name },
    };
  }

  // --- reading ------------------------------------------------------------------------------

  /** One page of a tab, in a stable order (ship day, then number); totals of every tab. */
  async list(site: SiteContext, query: OrderListQuery): Promise<OrderList> {
    const { view, page, pageSize } = query;
    const today = await this.today(site.siteId);
    const where = (v: OrderView): Prisma.OrderWhereInput => {
      const date = new Date(`${today}T00:00:00Z`);
      const base = { siteId: site.siteId };
      // Closed = handed to the carrier or cancelled; everything else still needs work (doc 029).
      if (v === 'closed') return { ...base, status: { in: ['HANDED_TO_CARRIER', 'CANCELLED'] } };
      const open = {
        ...base,
        status: { in: ['OPEN', 'READY_TO_DISPATCH', 'READY_FOR_PICKUP'] as OrderStatus[] },
      };
      if (v === 'today') return { ...open, requestedShipDate: date };
      if (v === 'future') return { ...open, requestedShipDate: { gt: date } };
      return { ...open, requestedShipDate: { lt: date } };
    };
    const [rows, ...counts] = await Promise.all([
      this.prisma.order.findMany({
        where: where(view),
        include: summaryInclude,
        orderBy:
          view === 'closed'
            ? [{ requestedShipDate: 'desc' }, { serial: 'desc' }]
            : [{ requestedShipDate: 'asc' }, { serial: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      ...(['today', 'future', 'overdue', 'closed'] as const).map((v) =>
        this.prisma.order.count({ where: where(v) }),
      ),
    ]);
    const total = {
      today: counts[0]!,
      future: counts[1]!,
      overdue: counts[2]!,
      closed: counts[3]!,
    };
    return {
      view,
      today,
      items: rows.map(toSummary),
      page,
      pageSize,
      total: total[view],
      counts: total,
    };
  }

  /** The orders of a hotel at the active site, newest first, one page (hotel detail). */
  async ofHotel(
    site: SiteContext,
    hotelCode: string,
    query: HotelOrdersQuery,
  ): Promise<HotelOrders> {
    const hotel = await this.hotels.byCode(hotelCode);
    if (!hotel) throw new NotFoundException('Hotel not found');
    const where = { siteId: site.siteId, hotelId: hotel.id };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: summaryInclude,
        orderBy: { serial: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: rows.map(toSummary), page: query.page, pageSize: query.pageSize, total };
  }

  async detail(site: SiteContext, code: string): Promise<OrderDetail> {
    const order = await this.find(this.prisma, code, site.siteId);
    if (!order) throw new NotFoundException('Order not found');
    const row = await this.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        ...summaryInclude,
        lines: {
          include: {
            product: { select: { code: true, name: true } },
            crateType: { select: { code: true, name: true } },
            recipeVersion: { select: { version: true } },
          },
          orderBy: { lineNo: 'asc' },
        },
        allocations: {
          where: { releasedAt: null },
          include: {
            crate: { select: { code: true } },
            cycle: {
              select: {
                capacity: true,
                labelTemplateVersionId: true,
                product: { select: { code: true, name: true } },
                recipeVersion: { select: { version: true } },
              },
            },
            allocator: { select: { displayName: true } },
          },
          orderBy: { allocatedAt: 'asc' },
        },
        events: {
          include: { actor: { select: { displayName: true } } },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        },
        creator: { select: { displayName: true } },
        completer: { select: { displayName: true } },
        canceller: { select: { displayName: true } },
        shipments: {
          where: { status: { not: 'CANCELLED' } },
          select: { code: true, status: true },
        },
      },
    });
    const designs = await this.labels.getVersionRefs([
      ...row.lines.flatMap((l) => l.labelTemplateVersionId ?? []),
      ...row.allocations.map((a) => a.cycle.labelTemplateVersionId),
    ]);
    const design = (id: string | null) => (id ? (designs.get(id)?.label ?? null) : null);
    return {
      ...toSummary(row),
      delivery: {
        hotelName: row.hotelName,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2,
        postalCode: row.postalCode,
        city: row.city,
        countryCode: row.countryCode,
      },
      contact: { name: row.contactName, phone: row.contactPhone, email: row.contactEmail },
      lines: row.lines.map((l) => ({
        lineNo: l.lineNo,
        product: l.product,
        crateType: l.crateType,
        capacity: l.capacity,
        recipeVersion: l.recipeVersion?.version ?? null,
        design: design(l.labelTemplateVersionId),
        requiredCrates: l.crates,
        loadedCrates: l.allocatedCrates,
        requiredBottles: l.bottles,
        loadedBottles: l.allocatedCrates * l.capacity,
      })),
      crates: row.allocations.map((a) => ({
        crate: a.crate.code,
        product: a.cycle.product,
        recipeVersion: a.cycle.recipeVersion.version,
        design: design(a.cycle.labelTemplateVersionId) ?? '',
        bottles: a.cycle.capacity,
        loadedAt: a.allocatedAt.toISOString(),
        loadedBy: a.allocator.displayName,
      })),
      history: row.events.map((e) => {
        const payload = (e.payload ?? {}) as {
          crate?: string;
          reason?: string;
          shipment?: string;
          parcels?: number;
        };
        return {
          type: e.type,
          occurredAt: e.occurredAt.toISOString(),
          actor: e.actor.displayName,
          crate: payload.crate ?? null,
          reason: payload.reason ?? null,
          shipment: payload.shipment ?? null,
          parcels: payload.parcels ?? null,
        };
      }),
      createdBy: row.creator.displayName,
      completedAt: row.completedAt?.toISOString() ?? null,
      completedBy: row.completer?.displayName ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledBy: row.canceller?.displayName ?? null,
      cancelReason: row.cancelReason,
      shipment: row.shipments[0] ?? null,
    };
  }

  /** Hotels the active site serves — the ones an order can be created for here. */
  hotelsServed(site: SiteContext): Promise<HotelSummary[]> {
    return this.hotels.list(site.siteId);
  }

  /** Active products with an active recipe: their crate type decides the bottles per crate. */
  async orderableProducts(): Promise<OrderableProduct[]> {
    const products = await this.prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
    const result: OrderableProduct[] = [];
    for (const p of products) {
      const unit = await this.crateUnit(this.prisma, p.id);
      if (unit) result.push({ code: p.code, name: p.name, ...unit.view });
    }
    return result;
  }

  // --- creating -----------------------------------------------------------------------------

  async create(
    actorId: string,
    site: SiteContext,
    input: CreateOrderRequest,
  ): Promise<OrderDetail> {
    const { result } = await this.operations.run(
      'ORDER_CREATE',
      input.requestId,
      { actorId, siteId: site.siteId, ...input, requestId: undefined },
      async (tx) => {
        // Serialised with a deactivation of the site (its lock); the site must have its warehouse.
        await lockSiteShared(tx, site.siteId);
        const served = await tx.site.count({
          where: { id: site.siteId, active: true, locations: { some: {} } },
        });
        if (served === 0) {
          throw domainError(409, 'SITE_WITHOUT_WAREHOUSE', 'The active site has no warehouse');
        }
        const hotel = await this.hotels.byCode(input.hotelCode, tx);
        if (!hotel) throw domainError(422, 'UNKNOWN_HOTEL', 'Unknown hotel');
        // The order belongs to the hotel's fulfilment site — never to another site.
        if (hotel.fulfillmentSiteId !== site.siteId) {
          throw domainErrorWithDetails(
            409,
            'HOTEL_OF_ANOTHER_SITE',
            'This hotel is served by another site',
            { site: hotel.fulfillmentSite.code },
          );
        }
        if (input.requestedShipDate < (await this.today(site.siteId, tx))) {
          throw domainError(422, 'SHIP_DATE_IN_PAST', 'The requested ship day is in the past');
        }
        const lines = [];
        for (const line of input.lines) {
          const product = await tx.product.findUnique({
            where: { code: line.productCode },
            select: { id: true, status: true },
          });
          if (!product || product.status !== 'ACTIVE') {
            throw domainErrorWithDetails(422, 'UNKNOWN_PRODUCT', 'Unknown or archived product', {
              product: line.productCode,
            });
          }
          const unit = await this.crateUnit(tx, product.id);
          if (!unit) {
            throw domainErrorWithDetails(
              422,
              'PRODUCT_WITHOUT_RECIPE',
              'The product has no active recipe with a crate type',
              { product: line.productCode },
            );
          }
          lines.push({ productId: product.id, crates: line.crates, ...unit.row });
        }
        const { first: serial } = await allocateSerials(tx, 'order', 1);
        const occurredAt = new Date();
        const order = await tx.order.create({
          data: {
            serial,
            code: formatCode(CODE_PREFIX.order, serial),
            hotelId: hotel.id,
            siteId: site.siteId,
            requestedShipDate: new Date(`${input.requestedShipDate}T00:00:00Z`),
            hotelName: hotel.name,
            addressLine1: hotel.addressLine1,
            addressLine2: hotel.addressLine2,
            postalCode: hotel.postalCode,
            city: hotel.city,
            countryCode: hotel.countryCode,
            contactName: hotel.contactName,
            contactPhone: hotel.contactPhone,
            contactEmail: hotel.contactEmail,
            createdAt: occurredAt,
            createdBy: actorId,
            operationRequestId: input.requestId,
            lines: {
              create: lines.map((l, i) => ({
                lineNo: i + 1,
                productId: l.productId,
                crateTypeId: l.crateTypeId,
                capacity: l.capacity,
                crates: l.crates,
                bottles: l.crates * l.capacity,
              })),
            },
          },
        });
        await this.event(tx, order.id, 'CREATED', {
          actorId,
          operationId: input.requestId,
          occurredAt,
        });
        return { code: order.code };
      },
    );
    return this.detail(site, result.code);
  }

  // --- picking ------------------------------------------------------------------------------

  async addCrate(
    actorId: string,
    site: SiteContext,
    code: string,
    input: OrderScanRequest,
  ): Promise<OrderScanResult> {
    const token = this.tokenOf(input.scannedValue);
    const { result } = await this.operations.run(
      'ORDER_CRATE_ADD',
      input.requestId,
      { actorId, siteId: site.siteId, code, token },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status !== 'OPEN') throw orderNotOpen(order.status);
        if ((await this.registry.kindOf(token, tx)) !== 'CRATE') {
          throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        }
        const crate = await this.cycles.crateByToken(tx, token);
        if (!crate) throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        if (crate.siteId !== site.siteId) {
          throw domainError(409, 'CRATE_OF_ANOTHER_SITE', 'This crate belongs to another site');
        }
        await this.cycles.lockCrate(tx, crate.id);
        const cycle = await this.cycles.openCycle(tx, crate.id, true);
        if (!cycle) {
          throw domainErrorWithDetails(409, 'CRATE_EMPTY', 'This crate holds no bottles', {
            crate: crate.code,
          });
        }
        const product = cycle.product;
        if (cycle.status === 'ALLOCATED') {
          const held = await tx.orderCrateAllocation.findFirstOrThrow({
            where: { cycleId: cycle.id, releasedAt: null },
            select: { orderId: true, order: { select: { code: true } } },
          });
          // A repeated scan changes nothing; another order keeps its crate.
          if (held.orderId === order.id) {
            return { outcome: 'ALREADY_IN_ORDER' as const, crate: crate.code, product };
          }
          throw domainErrorWithDetails(
            409,
            'CRATE_IN_ANOTHER_ORDER',
            'This crate is already loaded into another order',
            { crate: crate.code, order: held.order.code },
          );
        }
        if (cycle.status === 'DISPATCHED') {
          throw domainErrorWithDetails(
            409,
            'CRATE_DISPATCHED',
            'This crate was handed to the carrier with another order',
            { crate: crate.code },
          );
        }
        if (cycle.status !== 'FILLED') {
          throw domainErrorWithDetails(
            409,
            'CRATE_NOT_FINISHED',
            'Only a full, finished crate (Hotovo) is loaded',
            {
              crate: crate.code,
              status: cycle.status,
              memberCount: cycle.memberCount,
              filledCount: cycle.filledCount,
              capacity: cycle.capacity,
            },
          );
        }
        const line = order.lines.find((l) => l.productId === cycle.productId);
        if (!line) {
          throw domainErrorWithDetails(
            409,
            'PRODUCT_NOT_IN_ORDER',
            'This order does not contain the crate’s product',
            { crate: crate.code, product: product.code },
          );
        }
        if (line.crateTypeId !== cycle.crateTypeId || line.capacity !== cycle.capacity) {
          throw domainErrorWithDetails(
            409,
            'WRONG_CRATE_TYPE',
            'The crate is of another crate type than the order line',
            { crate: crate.code },
          );
        }
        if (line.allocatedCrates >= line.crates) {
          throw domainErrorWithDetails(
            409,
            'LINE_COMPLETE',
            'This product already has all ordered crates',
            { product: product.code, crates: line.crates },
          );
        }
        // One line never mixes recipe versions or label designs (owner 2026-10-17): the first
        // crate pins them; the database checks the allocation against the pins again.
        if (
          line.allocatedCrates > 0 &&
          (line.recipeVersionId !== cycle.recipeVersionId ||
            line.labelTemplateVersionId !== cycle.labelTemplateVersionId)
        ) {
          const refs = await this.labels.getVersionRefs(
            [line.labelTemplateVersionId!, cycle.labelTemplateVersionId],
            tx,
          );
          const pinned = await tx.recipeVersion.findUniqueOrThrow({
            where: { id: line.recipeVersionId! },
            select: { version: true },
          });
          throw domainErrorWithDetails(
            409,
            'LINE_VERSION_MISMATCH',
            'This product line already holds crates of another recipe version or label design',
            {
              crate: crate.code,
              line: {
                recipeVersion: pinned.version,
                design: refs.get(line.labelTemplateVersionId!)?.label ?? null,
              },
              scanned: {
                recipeVersion: cycle.recipeVersion.version,
                design: refs.get(cycle.labelTemplateVersionId)?.label ?? null,
              },
            },
          );
        }
        const members = await this.cycles.activeMembers(tx, cycle.id);
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.orderLine.update({
          where: { id: line.id },
          data: {
            allocatedCrates: { increment: 1 },
            recipeVersionId: cycle.recipeVersionId,
            labelTemplateVersionId: cycle.labelTemplateVersionId,
          },
        });
        await this.cycles.allocate(tx, cycle, { ...step, order: order.code });
        const allocation = await tx.orderCrateAllocation.create({
          data: {
            orderId: order.id,
            lineId: line.id,
            cycleId: cycle.id,
            crateId: crate.id,
            allocatedAt: step.occurredAt,
            allocatedBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        await tx.orderAllocationBottle.createMany({
          data: members.map((m) => ({
            allocationId: allocation.id,
            assignmentId: m.id,
            bottleId: m.bottle.id,
          })),
        });
        await this.event(tx, order.id, 'CRATE_ADDED', step, { crate: crate.code });
        return { outcome: 'ADDED' as const, crate: crate.code, product };
      },
    );
    return { ...result, order: await this.detail(site, code) };
  }

  async removeCrate(
    actorId: string,
    site: SiteContext,
    code: string,
    crateCode: string,
    input: RemoveOrderCrateRequest,
  ): Promise<OrderDetail> {
    await this.operations.run(
      'ORDER_CRATE_REMOVE',
      input.requestId,
      { actorId, siteId: site.siteId, code, crateCode, reason: input.reason },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status !== 'OPEN') throw orderNotOpen(order.status);
        const allocation = await tx.orderCrateAllocation.findFirst({
          where: { orderId: order.id, releasedAt: null, crate: { code: crateCode } },
          select: { id: true, crateId: true },
        });
        if (!allocation) {
          throw domainErrorWithDetails(
            409,
            'CRATE_NOT_IN_ORDER',
            'This crate is not in the order',
            {
              crate: crateCode,
            },
          );
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await this.release(tx, order, allocation, step, input.reason);
        await this.event(tx, order.id, 'CRATE_REMOVED', step, {
          crate: crateCode,
          reason: input.reason ?? undefined,
        });
        return { code: order.code };
      },
    );
    return this.detail(site, code);
  }

  async complete(
    actorId: string,
    site: SiteContext,
    code: string,
    input: CompleteOrderRequest,
  ): Promise<OrderDetail> {
    await this.operations.run(
      'ORDER_COMPLETE',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status !== 'OPEN') throw orderNotOpen(order.status);
        const missing = order.lines.filter((l) => l.allocatedCrates !== l.crates);
        if (missing.length > 0) {
          throw domainErrorWithDetails(
            409,
            'ORDER_INCOMPLETE',
            'Picking is complete only when every product has exactly its ordered crates',
            {
              lines: missing.map((l) => ({
                lineNo: l.lineNo,
                loaded: l.allocatedCrates,
                crates: l.crates,
              })),
            },
          );
        }
        const occurredAt = new Date();
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'READY_TO_DISPATCH', completedAt: occurredAt, completedBy: actorId },
        });
        const step = { actorId, operationId: input.requestId, occurredAt };
        await this.event(tx, order.id, 'COMPLETED', step);
        // The shipment and one parcel per crate follow from the completed picking (doc 029).
        await this.shipments.derive(tx, order, step);
        return { code: order.code };
      },
    );
    return this.detail(site, code);
  }

  async cancel(
    actorId: string,
    site: SiteContext,
    code: string,
    input: CancelOrderRequest,
  ): Promise<OrderDetail> {
    await this.operations.run(
      'ORDER_CANCEL',
      input.requestId,
      { actorId, siteId: site.siteId, code, reason: input.reason },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status === 'CANCELLED') throw orderNotOpen(order.status);
        if (order.status !== 'OPEN' && order.status !== 'READY_TO_DISPATCH') {
          // Ready for pickup: cancel the shipment's preparation first; handed over: final here.
          throw domainErrorWithDetails(
            409,
            'ORDER_NOT_CANCELLABLE',
            'This order cannot be cancelled now',
            {
              status: order.status,
            },
          );
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        // Only a shipment that never reached a carrier is cancelled with the order.
        await this.shipments.releaseForOrderCancel(tx, order.id, step, input.reason);
        // Cancelled first: its crates may then be released (the database allows a release only
        // from an open or cancelled order).
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: step.occurredAt,
            cancelledBy: actorId,
            cancelReason: input.reason,
          },
        });
        const held = await tx.orderCrateAllocation.findMany({
          where: { orderId: order.id, releasedAt: null },
          select: { id: true, crateId: true },
          orderBy: { crateId: 'asc' },
        });
        for (const allocation of held) {
          await this.release(tx, order, allocation, step, `Storno objednávky: ${input.reason}`);
        }
        await this.event(tx, order.id, 'CANCELLED', step, { reason: input.reason });
        return { code: order.code };
      },
    );
    return this.detail(site, code);
  }

  // --- helpers ------------------------------------------------------------------------------

  /** Releases one allocation: its cycle back to FILLED, the line counter −1, crate history. */
  private async release(
    tx: Prisma.TransactionClient,
    order: { id: string; code: string; lines: { id: string }[] },
    allocation: { id: string; crateId: string },
    step: { actorId: string; operationId: string; occurredAt: Date },
    reason: string | null,
  ): Promise<void> {
    await this.cycles.lockCrate(tx, allocation.crateId);
    const cycle = await this.cycles.openCycle(tx, allocation.crateId, true);
    const row = await tx.orderCrateAllocation.update({
      where: { id: allocation.id },
      data: {
        releasedAt: step.occurredAt,
        releasedBy: step.actorId,
        releaseReason: reason,
        releaseOperationId: step.operationId,
      },
      select: { lineId: true },
    });
    await this.cycles.releaseAllocation(tx, cycle!, { ...step, order: order.code, reason });
    // The last crate out releases the line's pinned versions (the order lock serialises this).
    const line = await tx.orderLine.findUniqueOrThrow({
      where: { id: row.lineId },
      select: { allocatedCrates: true },
    });
    const left = line.allocatedCrates - 1;
    await tx.orderLine.update({
      where: { id: row.lineId },
      data: {
        allocatedCrates: left,
        ...(left === 0 ? { recipeVersionId: null, labelTemplateVersionId: null } : {}),
      },
    });
  }

  /** The order of the active site, locked (operation → order → crate → cycle); 404 otherwise. */
  private async lockOrder(tx: Prisma.TransactionClient, code: string, siteId: string) {
    const found = await this.find(tx, code, siteId);
    if (!found) throw new NotFoundException('Order not found');
    await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    return tx.order.findUniqueOrThrow({
      where: { id: found.id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  }

  private find(db: Prisma.TransactionClient, code: string, siteId: string) {
    const serial = parseCodeSerial(CODE_PREFIX.order, code);
    if (serial === null) return Promise.resolve(null);
    return db.order.findFirst({ where: { serial, siteId }, select: { id: true } });
  }

  /** The crate unit of a product: its active recipe's crate type and capacity, or null. */
  private async crateUnit(db: Prisma.TransactionClient, productId: string) {
    const recipe = await this.recipes.activeVersion(db, productId);
    if (!recipe) return null;
    const crateTypeId = await this.recipes.crateTypeOf(db, recipe.id);
    if (!crateTypeId) return null;
    const type = await db.crateType.findUniqueOrThrow({
      where: { id: crateTypeId },
      select: { id: true, code: true, name: true, capacity: true },
    });
    return {
      row: { crateTypeId: type.id, capacity: type.capacity },
      view: { crateType: { code: type.code, name: type.name }, capacity: type.capacity },
    };
  }

  /** Today in the site's time zone (YYYY-MM-DD) — the overview tabs and the ship-day check. */
  private async today(siteId: string, db: Prisma.TransactionClient = this.prisma) {
    const { timeZone } = await db.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { timeZone: true },
    });
    return localDate(new Date(), timeZone);
  }

  private tokenOf(value: string): string {
    const scan = classifyScannedQr(value, this.env.PUBLIC_QR_BASE_URL);
    if (scan.kind === 'NOT_AYVO_QR') {
      throw domainError(422, 'NOT_AYVO_QR', 'This is not an AYVO QR code of this environment');
    }
    if (scan.kind === 'WRONG_ENVIRONMENT') {
      throw domainError(
        422,
        'WRONG_ENVIRONMENT',
        'This QR code belongs to another AYVO environment',
      );
    }
    return scan.token;
  }

  private async event(
    tx: Prisma.TransactionClient,
    orderId: string,
    type: 'CREATED' | 'CRATE_ADDED' | 'CRATE_REMOVED' | 'COMPLETED' | 'CANCELLED',
    step: { actorId: string; operationId: string; occurredAt: Date },
    payload: Record<string, string | undefined> = {},
  ): Promise<void> {
    await tx.orderEvent.create({
      data: {
        orderId,
        type,
        occurredAt: step.occurredAt,
        actorId: step.actorId,
        operationRequestId: step.operationId,
        payload: JSON.parse(JSON.stringify(payload)),
      },
    });
  }
}

/** The calendar day of an instant in an IANA time zone, as YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function toSummary(row: SummaryRecord): OrderSummary {
  const sum = (f: (l: SummaryRecord['lines'][number]) => number) =>
    row.lines.reduce((n, l) => n + f(l), 0);
  return {
    code: row.code,
    hotel: row.hotel,
    site: row.site,
    requestedShipDate: row.requestedShipDate.toISOString().slice(0, 10),
    status: row.status,
    totals: {
      requiredCrates: sum((l) => l.crates),
      loadedCrates: sum((l) => l.allocatedCrates),
      requiredBottles: sum((l) => l.crates * l.capacity),
      loadedBottles: sum((l) => l.allocatedCrates * l.capacity),
    },
    createdAt: row.createdAt.toISOString(),
  };
}
