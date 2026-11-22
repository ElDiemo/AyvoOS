import type { BottleCirculation, BottleCirculationList } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { CODE_PREFIX, parseCodeSerial } from '../common/codes.js';
import { PrismaService } from '../database/prisma.service.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { OrderReturnsService } from '../orders/order-returns.service.js';

/**
 * The operating view of bottles (doc 048 §3.0a, R3-c): readiness source, crate binding and
 * location, three things apart and each derived from existing records — nothing is written and
 * no combined status exists. Only bottles of the active site; another site's code is omitted.
 *
 * Location: a printed code with no label ("Kód čekající na nalepení") and a disposed bottle are
 * nowhere ("—"), never stock. A labelled bottle is at the site unless its latest live allocation
 * is with the carrier (IN_TRANSIT) or was delivered and the bottle has no SORTED of that cycle yet
 * (AT_HOTEL, with its order, hotel and delivery). The return is the bottle's own scan, never the
 * crate's.
 */
@Injectable()
export class BottleCirculationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderReturnsService,
  ) {}

  async ofCodes(codes: readonly string[], site: SiteContext): Promise<BottleCirculationList> {
    const serials = codes
      .map((c) => parseCodeSerial(CODE_PREFIX.bottle, c))
      .filter((s): s is bigint => s !== null);
    const bottles = await this.prisma.bottle.findMany({
      where: { serial: { in: serials }, siteId: site.siteId },
      select: {
        id: true,
        code: true,
        status: true,
        events: {
          where: { type: { in: ['LABEL_APPLIED', 'REUSE_READY', 'SORTED'] } },
          orderBy: { id: 'asc' },
          select: { type: true, crateCycleId: true },
        },
        assignments: {
          where: { releasedAt: null },
          select: { cycle: { select: { status: true, crate: { select: { code: true } } } } },
        },
      },
    });
    const shipped = await this.orders.lastShipments(
      this.prisma,
      bottles.map((b) => b.id),
    );
    const byCode = new Map(
      bottles.map((b): [string, BottleCirculation] => {
        const start = b.events.findLast(
          (e) => e.type === 'LABEL_APPLIED' || e.type === 'REUSE_READY',
        );
        const member = b.assignments[0] ?? null;
        const ship = shipped.get(b.id);
        const sorted = (cycleId: string) =>
          b.events.some((e) => e.type === 'SORTED' && e.crateCycleId === cycleId);
        const none = { orderCode: null, hotelName: null, deliveredAt: null };
        let location: BottleCirculation['location'];
        if (b.status === 'CREATED' || b.status === 'DISPOSED') location = { kind: 'NONE', ...none };
        else if (ship && ship.deliveredAt && !sorted(ship.cycleId))
          location = {
            kind: 'AT_HOTEL',
            orderCode: ship.orderCode,
            hotelName: ship.hotelName,
            deliveredAt: ship.deliveredAt.toISOString(),
          };
        else if (
          ship &&
          !ship.deliveredAt &&
          (ship.pickedUp || ship.cycleStatus === 'DISPATCHED') &&
          !sorted(ship.cycleId)
        )
          location = {
            kind: 'IN_TRANSIT',
            orderCode: ship.orderCode,
            hotelName: ship.hotelName,
            deliveredAt: null,
          };
        else location = { kind: 'AT_SITE', ...none };
        return [
          b.code,
          {
            code: b.code,
            source: !start ? null : start.type === 'REUSE_READY' ? 'AFTER_WASH' : 'NEW',
            crate: member
              ? { code: member.cycle.crate.code, cycleStatus: member.cycle.status }
              : null,
            location,
          },
        ];
      }),
    );
    // In the order asked for; codes of another site (or unknown) are simply absent.
    return {
      items: codes.map((c) => byCode.get(c)).filter((x): x is BottleCirculation => !!x),
    };
  }
}
