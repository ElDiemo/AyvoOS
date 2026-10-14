import type { CycleState } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';

const cycleInclude = {
  product: { select: { code: true, name: true } },
  recipeVersion: { select: { version: true } },
} satisfies Prisma.CrateCycleInclude;
export type CycleRecord = Prisma.CrateCycleGetPayload<{ include: typeof cycleInclude }>;

/**
 * Crate cycles and their members (ADR 0021, ADR 0025 proposed, doc 025 §3.2): one circulation of
 * one crate with an immutable snapshot (crate type, capacity, product, category, recipe version,
 * label design). Labelling (A3) opens a cycle with its first bottle and adds members until the
 * capacity makes it READY_TO_FILL. Everything runs in the caller's transaction; the database
 * re-checks counts, statuses and snapshots at commit.
 */
@Injectable()
export class CrateCyclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly labels: LabelTemplatesService,
  ) {}

  /** The crate behind a QR token (with its type's categories), or null. Not locked. */
  crateByToken(db: Prisma.TransactionClient, token: string) {
    return db.crate.findUnique({
      where: { qrToken: token },
      include: { crateType: { include: { categories: true } } },
    });
  }

  crateById(db: Prisma.TransactionClient, id: string) {
    return db.crate.findUniqueOrThrow({
      where: { id },
      include: { crateType: { include: { categories: true } } },
    });
  }

  /** Lock order: … → crate → cycle → bottle → balances (doc 020 §8). */
  async lockCrate(tx: Prisma.TransactionClient, crateId: string): Promise<void> {
    await tx.$executeRaw`SELECT 1 FROM "crates" WHERE "id" = ${crateId}::uuid FOR UPDATE`;
  }

  /** The crate's open (not aborted) cycle, locked when a transaction asks for it. */
  async openCycle(
    db: Prisma.TransactionClient,
    crateId: string,
    lock = false,
  ): Promise<CycleRecord | null> {
    const found = await db.crateCycle.findFirst({
      where: { crateId, status: { not: 'ABORTED' } },
      select: { id: true },
    });
    if (!found) return null;
    if (lock) {
      await db.$executeRaw`SELECT 1 FROM "crate_cycles" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    }
    return db.crateCycle.findUniqueOrThrow({ where: { id: found.id }, include: cycleInclude });
  }

  /** Opens a new cycle (OPEN_ASSEMBLY, empty) with its CYCLE_OPENED crate event. */
  async createCycle(
    tx: Prisma.TransactionClient,
    input: {
      crate: { id: string; siteId: string; crateTypeId: string; capacity: number };
      productId: string;
      categoryCode: string;
      recipeVersionId: string;
      labelTemplateVersionId: string;
      actorId: string;
      operationId: string;
      occurredAt: Date;
    },
  ): Promise<CycleRecord> {
    const cycle = await tx.crateCycle.create({
      data: {
        crateId: input.crate.id,
        siteId: input.crate.siteId,
        crateTypeId: input.crate.crateTypeId,
        capacity: input.crate.capacity,
        productId: input.productId,
        categoryCode: input.categoryCode,
        recipeVersionId: input.recipeVersionId,
        labelTemplateVersionId: input.labelTemplateVersionId,
        openedAt: input.occurredAt,
        openedBy: input.actorId,
        openOperationId: input.operationId,
      },
      include: cycleInclude,
    });
    await tx.crateEvent.create({
      data: {
        crateId: input.crate.id,
        cycleId: cycle.id,
        type: 'CYCLE_OPENED',
        occurredAt: input.occurredAt,
        actorId: input.actorId,
        siteId: input.crate.siteId,
        operationRequestId: input.operationId,
      },
    });
    return cycle;
  }

  /** Is the bottle an active member of the cycle? */
  async isActiveMember(db: Prisma.TransactionClient, cycleId: string, bottleId: string) {
    return (await db.crateAssignment.count({ where: { cycleId, bottleId, releasedAt: null } })) > 0;
  }

  /** The bottle's active membership (any cycle) with its crate code, or null. */
  activeMembership(db: Prisma.TransactionClient, bottleId: string) {
    return db.crateAssignment.findFirst({
      where: { bottleId, releasedAt: null },
      select: { cycleId: true, cycle: { select: { crate: { select: { code: true } } } } },
    });
  }

  /**
   * Adds a member at the lowest free ordinal; the capacity-th member moves the cycle to
   * READY_TO_FILL with its crate event (ADR 0021 §3). The caller holds the cycle lock.
   */
  async addMember(
    tx: Prisma.TransactionClient,
    cycle: CycleRecord,
    input: {
      bottleId: string;
      assignedEventId: string;
      actorId: string;
      operationId: string;
      occurredAt: Date;
    },
  ): Promise<CycleRecord> {
    const taken = await tx.crateAssignment.findMany({
      where: { cycleId: cycle.id, releasedAt: null },
      select: { ordinal: true },
    });
    const used = new Set(taken.map((a) => a.ordinal));
    let ordinal = 1;
    while (used.has(ordinal)) ordinal++;
    await tx.crateAssignment.create({
      data: {
        cycleId: cycle.id,
        cycleCapacity: cycle.capacity,
        bottleId: input.bottleId,
        ordinal,
        source: 'LABELING',
        assignedAt: input.occurredAt,
        assignedBy: input.actorId,
        operationRequestId: input.operationId,
        assignedEventId: input.assignedEventId,
      },
    });
    const members = cycle.memberCount + 1;
    const full = members === cycle.capacity;
    const updated = await tx.crateCycle.update({
      where: { id: cycle.id },
      data: {
        memberCount: members,
        ...(full ? { status: 'READY_TO_FILL', readyToFillAt: input.occurredAt } : {}),
      },
      include: cycleInclude,
    });
    if (full) {
      await tx.crateEvent.create({
        data: {
          crateId: cycle.crateId,
          cycleId: cycle.id,
          type: 'READY_TO_FILL',
          occurredAt: input.occurredAt,
          actorId: input.actorId,
          siteId: cycle.siteId,
          operationRequestId: input.operationId,
        },
      });
    }
    return updated;
  }

  async toState(
    cycle: CycleRecord,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<CycleState> {
    const design = (await this.labels.getVersionRefs([cycle.labelTemplateVersionId], db)).get(
      cycle.labelTemplateVersionId,
    )!;
    return {
      status: cycle.status,
      memberCount: cycle.memberCount,
      capacity: cycle.capacity,
      product: cycle.product,
      recipeVersion: cycle.recipeVersion.version,
      design,
    };
  }
}
