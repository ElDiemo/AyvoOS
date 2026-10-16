import type {
  CrateContent,
  OutsideBottle,
  OutsideBottleGroup,
  OutsideBottlesPage,
  OutsideBottlesQuery,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { CODE_PREFIX, parseCodeSerial } from '../common/codes.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { CrateCyclesService } from '../crates/crate-cycles.service.js';
import { CratesService } from '../crates/crates.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';

/**
 * Read models of the crate overview (doc 025 A5), for the active site only: the content of a
 * crate's open cycle (members with their state and liquid lot, snapshot, counts, aborted
 * circulations) and the labelled bottles that are in no crate (§3.3) — labelled empties,
 * finished bottles and bottles labelled before crates were recorded.
 */
@Injectable()
export class CrateContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crates: CratesService,
    private readonly cycles: CrateCyclesService,
    private readonly labels: LabelTemplatesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async content(code: string, siteId: string): Promise<CrateContent> {
    const crate = await this.crates.findOfSite(code, siteId);
    const open = await this.prisma.crateCycle.findFirst({
      where: { crateId: crate.id, status: { not: 'ABORTED' } },
      include: { product: { select: { code: true, name: true } }, recipeVersion: true },
    });
    const members = open ? await this.cycles.activeMembers(this.prisma, open.id) : [];
    const lots = await this.prisma.bottleEvent.findMany({
      where: { type: 'FILLED', bottleId: { in: members.map((m) => m.bottle.id) } },
      select: { bottleId: true, liquidLot: { select: { code: true } } },
    });
    const lotOf = new Map(lots.map((l) => [l.bottleId, l.liquidLot?.code ?? null]));
    const aborted = await this.prisma.crateCycle.findMany({
      where: { crateId: crate.id, status: 'ABORTED' },
      include: { product: { select: { code: true, name: true } } },
      orderBy: { abortedAt: 'desc' },
    });
    const design = open
      ? (await this.labels.getVersionRefs([open.labelTemplateVersionId])).get(
          open.labelTemplateVersionId,
        )!
      : null;
    return {
      crate: { code: crate.code, capacity: crate.crateType.capacity },
      cycle:
        open && design
          ? {
              status: open.status,
              product: open.product,
              category: open.categoryCode,
              recipeVersion: open.recipeVersion.version,
              design,
              memberCount: open.memberCount,
              filledCount: open.filledCount,
              capacity: open.capacity,
              openedAt: open.openedAt.toISOString(),
              readyToFillAt: open.readyToFillAt?.toISOString() ?? null,
              filledAt: open.filledAt?.toISOString() ?? null,
            }
          : null,
      members: members.map((m) => ({
        ordinal: m.ordinal,
        bottle: { code: m.bottle.code, status: m.bottle.status },
        source: m.source,
        assignedAt: m.assignedAt.toISOString(),
        liquidLot: lotOf.get(m.bottle.id) ?? null,
      })),
      aborted: aborted.map((c) => ({
        product: c.product,
        openedAt: c.openedAt.toISOString(),
        abortedAt: c.abortedAt!.toISOString(),
        reason: c.abortReason!,
      })),
    };
  }

  /**
   * One group of bottles outside a crate, one bounded page (never the whole list), optionally an
   * exact search by code or scanned QR URL; the active site only, read-only.
   */
  async outside(siteId: string, query: OutsideBottlesQuery): Promise<OutsideBottlesPage> {
    const groups: Record<OutsideBottleGroup, Prisma.BottleWhereInput> = {
      finished: {
        siteId,
        status: 'FILLED',
        assignments: { none: { releasedAt: null } },
        binding: { isNot: null },
      },
      labelledEmpty: {
        siteId,
        status: 'LABELED_EMPTY',
        assignments: { none: { releasedAt: null } },
        binding: { isNot: null },
      },
      legacy: { siteId, status: 'LABELED_EMPTY', binding: { is: null } },
    };
    const where: Prisma.BottleWhereInput = { ...groups[query.group] };
    if (query.search) {
      const scan = classifyScannedQr(query.search, this.env.PUBLIC_QR_BASE_URL);
      const serial = parseCodeSerial(CODE_PREFIX.bottle, query.search.toUpperCase());
      // An unparsable search matches nothing (never "everything").
      if (scan.kind === 'TOKEN') where.publicToken = scan.token;
      else where.serial = serial ?? -1n;
    }
    const [total, rows, ...counts] = await Promise.all([
      this.prisma.bottle.count({ where }),
      this.prisma.bottle.findMany({
        where,
        orderBy: { serial: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          binding: {
            include: {
              product: { select: { code: true, name: true } },
              crateCycle: { include: { recipeVersion: { select: { version: true } } } },
            },
          },
          events: {
            where: { type: { in: ['FILLED', 'REMOVED_FROM_CRATE'] } },
            orderBy: { occurredAt: 'desc' },
            include: {
              liquidLot: { select: { code: true } },
              crateCycle: { select: { crate: { select: { code: true } } } },
            },
          },
        },
      }),
      ...(['finished', 'labelledEmpty', 'legacy'] as const).map((g) =>
        this.prisma.bottle.count({ where: groups[g] }),
      ),
    ]);
    const designs = await this.labels.getVersionRefs(
      rows.flatMap((r) => (r.binding ? [r.binding.labelTemplateVersionId] : [])),
    );
    return {
      group: query.group,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totals: { finished: counts[0]!, labelledEmpty: counts[1]!, legacy: counts[2]! },
      items: rows.map((r): OutsideBottle => {
        const filled = r.events.find((e) => e.type === 'FILLED');
        const removed = r.events.find((e) => e.type === 'REMOVED_FROM_CRATE');
        const payload = (removed?.payload ?? {}) as { reason?: unknown };
        return {
          code: r.code,
          status: r.status,
          product: r.binding?.product ?? null,
          recipeVersion: r.binding?.crateCycle.recipeVersion.version ?? null,
          design: r.binding ? (designs.get(r.binding.labelTemplateVersionId)?.label ?? null) : null,
          liquidLot: filled?.liquidLot?.code ?? null,
          lastCrate: removed?.crateCycle?.crate.code ?? null,
          leftAt: removed?.occurredAt.toISOString() ?? null,
          reason: typeof payload.reason === 'string' ? payload.reason : null,
        };
      }),
    };
  }
}
