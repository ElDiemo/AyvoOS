import type { CrateContent, OutsideBottle, OutsideBottles } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { CrateCyclesService } from '../crates/crate-cycles.service.js';
import { CratesService } from '../crates/crates.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { BottleStatus, Prisma } from '../generated/prisma/client.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';

const OUTSIDE_LIMIT = 200;

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

  async outside(siteId: string): Promise<OutsideBottles> {
    const base = (status: BottleStatus, bound: boolean): Prisma.BottleWhereInput => ({
      siteId,
      status,
      assignments: { none: { releasedAt: null } },
      binding: bound ? { isNot: null } : { is: null },
    });
    const groups = {
      labelledEmpty: base('LABELED_EMPTY', true),
      finished: base('FILLED', true),
      legacy: { siteId, status: 'LABELED_EMPTY' as const, binding: { is: null } },
    };
    const result = {} as Record<keyof typeof groups, OutsideBottle[]>;
    const totals = {} as OutsideBottles['totals'];
    for (const [key, where] of Object.entries(groups) as [
      keyof typeof groups,
      Prisma.BottleWhereInput,
    ][]) {
      const [count, rows] = await Promise.all([
        this.prisma.bottle.count({ where }),
        this.prisma.bottle.findMany({
          where,
          orderBy: { serial: 'asc' },
          take: OUTSIDE_LIMIT,
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
      ]);
      totals[key] = count;
      const designs = await this.labels.getVersionRefs(
        rows.flatMap((r) => (r.binding ? [r.binding.labelTemplateVersionId] : [])),
      );
      result[key] = rows.map((r) => {
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
      });
    }
    return { ...result, totals, limit: OUTSIDE_LIMIT };
  }
}
