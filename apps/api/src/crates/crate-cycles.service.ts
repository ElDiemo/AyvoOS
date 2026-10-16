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
 * capacity makes it READY_TO_FILL; filling (A4) counts filled members, Hotovo makes it FILLED,
 * and supervised corrections release or add members. Everything runs in the caller's transaction; the database
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

  /**
   * Opens a new cycle with its CYCLE_OPENED crate event: empty, in OPEN_ASSEMBLY (labelling) or —
   * for "Přeložit hotové lahve" into an empty crate — in FILLING with the bottles' snapshot.
   */
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
      status?: 'OPEN_ASSEMBLY' | 'FILLING';
    },
  ): Promise<CycleRecord> {
    const cycle = await tx.crateCycle.create({
      data: {
        status: input.status ?? 'OPEN_ASSEMBLY',
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
      /** LABELING (scan) by default; supervised repack or replacement otherwise. */
      source?: 'LABELING' | 'REPACKED' | 'REPLACEMENT';
      /** The bottle is already filled (repack of a finished bottle). */
      filled?: boolean;
      reason?: string;
      bottleCode?: string;
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
        source: input.source ?? 'LABELING',
        assignedAt: input.occurredAt,
        assignedBy: input.actorId,
        operationRequestId: input.operationId,
        assignedEventId: input.assignedEventId,
      },
    });
    const members = cycle.memberCount + 1;
    const filled = cycle.filledCount + (input.filled ? 1 : 0);
    // A finished bottle makes an assembling crate FILLING (sticky); only an assembling crate of
    // empties becomes READY_TO_FILL with its capacity-th member (ADR 0021 §3).
    const startsFilling = input.filled === true && cycle.status === 'OPEN_ASSEMBLY';
    const full = !startsFilling && cycle.status === 'OPEN_ASSEMBLY' && members === cycle.capacity;
    const updated = await tx.crateCycle.update({
      where: { id: cycle.id },
      data: {
        memberCount: members,
        filledCount: filled,
        ...(full ? { status: 'READY_TO_FILL', readyToFillAt: input.occurredAt } : {}),
        ...(startsFilling ? { status: 'FILLING' } : {}),
      },
      include: cycleInclude,
    });
    if (input.source && input.source !== 'LABELING') {
      await this.event(tx, cycle, 'MEMBER_ADDED', input, {
        bottle: input.bottleCode,
        source: input.source,
        reason: input.reason,
      });
    }
    if (startsFilling) await this.event(tx, cycle, 'FILLING_STARTED', input);
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

  /** A member was filled (doc 025 A4): Naplněno +1; the first one makes the crate FILLING. */
  async memberFilled(
    tx: Prisma.TransactionClient,
    cycle: CycleRecord,
    input: { actorId: string; operationId: string; occurredAt: Date },
  ): Promise<CycleRecord> {
    const starts = cycle.status === 'READY_TO_FILL';
    const updated = await tx.crateCycle.update({
      where: { id: cycle.id },
      data: { filledCount: cycle.filledCount + 1, ...(starts ? { status: 'FILLING' } : {}) },
      include: cycleInclude,
    });
    if (starts) await this.event(tx, cycle, 'FILLING_STARTED', input);
    return updated;
  }

  /** Hotovo: FILLING → FILLED ("Připravená") with its CRATE_FILLED event. Caller checked counts. */
  async finish(
    tx: Prisma.TransactionClient,
    cycle: CycleRecord,
    input: { actorId: string; operationId: string; occurredAt: Date },
  ): Promise<CycleRecord> {
    const updated = await tx.crateCycle.update({
      where: { id: cycle.id },
      data: { status: 'FILLED', filledAt: input.occurredAt },
      include: cycleInclude,
    });
    await this.event(tx, cycle, 'CRATE_FILLED', input);
    return updated;
  }

  /** "Vrátit do rozpracování": FILLED → FILLING, with the reason. */
  async reopen(
    tx: Prisma.TransactionClient,
    cycle: CycleRecord,
    input: { actorId: string; operationId: string; occurredAt: Date; reason: string },
  ): Promise<CycleRecord> {
    const updated = await tx.crateCycle.update({
      where: { id: cycle.id },
      data: { status: 'FILLING', filledAt: null },
      include: cycleInclude,
    });
    await this.event(tx, cycle, 'RETURNED_TO_FILLING', input, { reason: input.reason });
    return updated;
  }

  /** The cycle's active assignments, in ordinal order, with their bottles. */
  activeMembers(db: Prisma.TransactionClient, cycleId: string) {
    return db.crateAssignment.findMany({
      where: { cycleId, releasedAt: null },
      orderBy: { ordinal: 'asc' },
      include: { bottle: { select: { id: true, code: true, status: true } } },
    });
  }

  /**
   * Releases one membership (supervised removal or abort): the assignment's release, Obsah −1,
   * Naplněno −1 for a filled bottle; an assembling crate below capacity is OPEN_ASSEMBLY again.
   * FILLING stays FILLING (sticky). The bottle keeps its status — nothing is re-emptied.
   */
  async releaseMember(
    tx: Prisma.TransactionClient,
    cycle: CycleRecord,
    input: {
      assignmentId: string;
      bottleFilled: boolean;
      actorId: string;
      operationId: string;
      occurredAt: Date;
      reason: string;
    },
  ): Promise<CycleRecord> {
    await tx.crateAssignment.update({
      where: { id: input.assignmentId },
      data: {
        releasedAt: input.occurredAt,
        releasedBy: input.actorId,
        releaseReason: input.reason,
        releaseOperationId: input.operationId,
      },
    });
    return tx.crateCycle.update({
      where: { id: cycle.id },
      data: {
        memberCount: cycle.memberCount - 1,
        filledCount: cycle.filledCount - (input.bottleFilled ? 1 : 0),
        ...(cycle.status === 'READY_TO_FILL'
          ? { status: 'OPEN_ASSEMBLY', readyToFillAt: null }
          : {}),
      },
      include: cycleInclude,
    });
  }

  /** "Zrušit oběh": the (already emptied) cycle becomes ABORTED with the reason and its event. */
  async abort(
    tx: Prisma.TransactionClient,
    cycle: CycleRecord,
    input: { actorId: string; operationId: string; occurredAt: Date; reason: string },
  ): Promise<void> {
    await tx.crateCycle.update({
      where: { id: cycle.id },
      data: {
        status: 'ABORTED',
        abortedAt: input.occurredAt,
        abortedBy: input.actorId,
        abortReason: input.reason,
      },
    });
    await this.event(tx, cycle, 'CYCLE_ABORTED', input, { reason: input.reason });
  }

  /** A crate event of the cycle (actor, operation, optional payload such as the reason). */
  async event(
    tx: Prisma.TransactionClient,
    cycle: Pick<CycleRecord, 'id' | 'crateId' | 'siteId'>,
    type:
      | 'FILLING_STARTED'
      | 'CRATE_FILLED'
      | 'RETURNED_TO_FILLING'
      | 'CYCLE_ABORTED'
      | 'MEMBER_REMOVED'
      | 'MEMBER_ADDED',
    input: { actorId: string; operationId: string; occurredAt: Date },
    payload: Record<string, string | undefined> = {},
  ): Promise<void> {
    await tx.crateEvent.create({
      data: {
        crateId: cycle.crateId,
        cycleId: cycle.id,
        type,
        occurredAt: input.occurredAt,
        actorId: input.actorId,
        siteId: cycle.siteId,
        operationRequestId: input.operationId,
        payload: JSON.parse(JSON.stringify(payload)),
      },
    });
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
      filledCount: cycle.filledCount,
      capacity: cycle.capacity,
      product: cycle.product,
      recipeVersion: cycle.recipeVersion.version,
      design,
    };
  }
}
