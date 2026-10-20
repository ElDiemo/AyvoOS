import type {
  AddCrateMemberRequest,
  CycleCorrectionResult,
  CycleReasonRequest,
  RemoveCrateMemberRequest,
} from '@ayvo/types';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
import { RecipesService } from '../catalog/recipes.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import {
  CrateCyclesService,
  type CycleRecord,
  isHeldByOrder,
} from '../crates/crate-cycles.service.js';
import { CratesService } from '../crates/crates.service.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/** A crate held by an order (doc 028) keeps its bottles: remove it from the order first. */
/** A crate held by an order: loaded (removable from the order) or handed to the carrier. */
export const crateAllocated = (status?: string) =>
  status === 'DISPATCHED'
    ? domainError(409, 'CRATE_DISPATCHED', 'This crate was handed to the carrier with its order')
    : status === 'DELIVERED'
      ? domainError(409, 'CRATE_DELIVERED', 'This crate was delivered with its order')
      : domainError(
          409,
          'CRATE_ALLOCATED',
          'This crate is loaded into an order: remove it from the order first',
        );

const crateReady = () =>
  domainError(
    409,
    'CRATE_READY',
    'This crate is ready (Hotovo): return it to filling first ("Vrátit do rozpracování")',
  );

/**
 * Supervised corrections of crate cycles (doc 025 §4.2, owner B4; `production:cycle_correct`,
 * reason required, crates of the active site only): Vyjmout lahev, Doplnit / Přeložit lahev
 * (incl. finished bottles into an empty crate), Vrátit do rozpracování and Zrušit oběh. They move
 * memberships only: a bottle keeps its status (a finished bottle never becomes empty) and nothing
 * is consumed or returned to stock. Every step re-checks site and snapshot; a refusal writes
 * nothing.
 *
 * Lock order: operation request → crate → cycle → bottle (no session: these act on the crate).
 */
@Injectable()
export class CycleCorrectionsService {
  constructor(
    private readonly operations: OperationRequestsService,
    private readonly crates: CratesService,
    private readonly cycles: CrateCyclesService,
    private readonly bottles: BottlesService,
    private readonly recipes: RecipesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Vyjmout lahev: the bottle leaves the crate's open cycle (it keeps its status). */
  async remove(
    actorId: string,
    siteId: string,
    crateCode: string,
    input: RemoveCrateMemberRequest,
  ): Promise<CycleCorrectionResult> {
    const { result } = await this.operations.run(
      'CYCLE_MEMBER_REMOVE',
      input.requestId,
      { actorId, siteId, crateCode, bottle: input.bottle, reason: input.reason },
      async (tx) => {
        const { crate, cycle } = await this.lockedCycle(tx, crateCode, siteId);
        if (!cycle) throw this.noCycle();
        if (isHeldByOrder(cycle.status)) throw crateAllocated(cycle.status);
        if (cycle.status === 'FILLED') throw crateReady();
        const bottle = await this.bottleOf(tx, input.bottle, siteId);
        const status = await this.bottles.lockForLabelApplication(tx, bottle.id);
        const assignment = await tx.crateAssignment.findFirst({
          where: { cycleId: cycle.id, bottleId: bottle.id, releasedAt: null },
          select: { id: true },
        });
        if (!assignment) {
          throw domainError(409, 'NOT_IN_THIS_CRATE', 'This bottle is not in this crate');
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        const updated = await this.cycles.releaseMember(tx, cycle, {
          ...step,
          assignmentId: assignment.id,
          bottleFilled: status === 'FILLED',
          reason: input.reason,
        });
        await this.bottles.removedFromCrateEvent(tx, {
          bottleId: bottle.id,
          occurredAt: step.occurredAt,
          actorId,
          crateCycleId: cycle.id,
          operationRequestId: input.requestId,
          crateCode: crate.code,
          reason: input.reason,
        });
        await this.cycles.event(tx, cycle, 'MEMBER_REMOVED', step, {
          bottle: bottle.code,
          reason: input.reason,
        });
        return { crate: { code: crate.code }, cycle: await this.cycles.toState(updated, tx) };
      },
    );
    return result;
  }

  /**
   * Doplnit / Přeložit lahev: a labelled bottle outside any crate, with exactly the cycle's
   * snapshot (product, label design, recipe version), into a free place of the open cycle — an
   * empty one into an assembling or filling crate, a finished one into any of them (an assembling
   * crate then fills). Into an EMPTY crate only finished bottles ("Přeložit hotové lahve"): the
   * first opens a FILLING cycle with its snapshot. Never a consumption.
   */
  async add(
    actorId: string,
    siteId: string,
    crateCode: string,
    input: AddCrateMemberRequest,
  ): Promise<CycleCorrectionResult> {
    const { result } = await this.operations.run(
      'CYCLE_MEMBER_ADD',
      input.requestId,
      { actorId, siteId, crateCode, bottle: input.bottle, reason: input.reason },
      async (tx) => {
        const { crate, cycle: open } = await this.lockedCycle(tx, crateCode, siteId);
        const bottle = await this.bottleOf(tx, input.bottle, siteId);
        const status = await this.bottles.lockForLabelApplication(tx, bottle.id);
        if (status === 'CREATED') {
          throw domainError(409, 'BOTTLE_NOT_LABELED', 'This bottle has no label yet');
        }
        const binding = await this.bottles.productBinding(tx, bottle.id);
        if (!binding) {
          throw domainError(
            409,
            'BOTTLE_NOT_BOUND',
            'This bottle was labelled before crates were recorded and has no product binding',
          );
        }
        const elsewhere = await this.cycles.activeMembership(tx, bottle.id);
        if (elsewhere) {
          throw domainErrorWithDetails(
            409,
            'IN_ANOTHER_CRATE',
            `This bottle is in crate ${elsewhere.cycle.crate.code}`,
            { crate: elsewhere.cycle.crate.code },
          );
        }
        const origin = await tx.crateCycle.findUniqueOrThrow({
          where: { id: binding.crateCycleId },
        });
        const filled = status === 'FILLED';
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        let cycle: CycleRecord;
        let source: 'REPACKED' | 'REPLACEMENT';
        if (open) {
          if (isHeldByOrder(open.status)) throw crateAllocated(open.status);
          if (open.status === 'FILLED') throw crateReady();
          if (open.status === 'READY_TO_FILL' || open.memberCount >= open.capacity) {
            throw domainError(409, 'CRATE_FULL', 'This crate has no free place');
          }
          if (
            open.productId !== binding.productId ||
            open.labelTemplateVersionId !== binding.labelTemplateVersionId ||
            open.recipeVersionId !== origin.recipeVersionId
          ) {
            throw domainError(
              409,
              'SNAPSHOT_MISMATCH',
              'This bottle has another product, label design or recipe version than the crate',
            );
          }
          cycle = open;
          source = open.status === 'FILLING' && !filled ? 'REPLACEMENT' : 'REPACKED';
        } else {
          if (!filled) {
            throw domainError(
              409,
              'EMPTY_CRATE_TAKES_FINISHED',
              'An empty crate takes only finished bottles; a labelled empty bottle goes into a crate assembling the same product',
            );
          }
          if ((await this.recipes.crateTypeOf(tx, origin.recipeVersionId)) !== crate.crateTypeId) {
            throw domainError(
              422,
              'CRATE_TYPE_MISMATCH',
              'This crate type is not the crate type of the bottle’s recipe',
            );
          }
          if (crate.status !== 'ACTIVE') {
            throw domainError(409, 'CRATE_RETIRED', 'This crate is not in service');
          }
          cycle = await this.cycles.createCycle(tx, {
            crate: {
              id: crate.id,
              siteId: crate.siteId,
              crateTypeId: crate.crateTypeId,
              capacity: crate.crateType.capacity,
            },
            productId: origin.productId,
            categoryCode: origin.categoryCode,
            recipeVersionId: origin.recipeVersionId,
            labelTemplateVersionId: origin.labelTemplateVersionId,
            status: 'FILLING',
            ...step,
          });
          source = 'REPACKED';
        }
        const assigned = await this.bottles.assignedToCrateEvent(tx, {
          bottleId: bottle.id,
          occurredAt: step.occurredAt,
          actorId,
          crateCycleId: cycle.id,
          workstationSessionId: null,
          operationRequestId: input.requestId,
          crateCode: crate.code,
          source,
          reason: input.reason,
        });
        const updated = await this.cycles.addMember(tx, cycle, {
          ...step,
          bottleId: bottle.id,
          assignedEventId: assigned.eventId,
          source,
          filled,
          reason: input.reason,
          bottleCode: bottle.code,
        });
        return { crate: { code: crate.code }, cycle: await this.cycles.toState(updated, tx) };
      },
    );
    return result;
  }

  /** Vrátit do rozpracování: a ready crate (FILLED) back to FILLING, before any allocation. */
  async reopen(
    actorId: string,
    siteId: string,
    crateCode: string,
    input: CycleReasonRequest,
  ): Promise<CycleCorrectionResult> {
    const { result } = await this.operations.run(
      'CYCLE_REOPEN',
      input.requestId,
      { actorId, siteId, crateCode, reason: input.reason },
      async (tx) => {
        const { crate, cycle } = await this.lockedCycle(tx, crateCode, siteId);
        if (cycle && isHeldByOrder(cycle.status)) throw crateAllocated(cycle.status);
        if (!cycle || cycle.status !== 'FILLED') {
          throw domainError(409, 'CRATE_NOT_READY', 'Only a ready crate (Hotovo) is returned');
        }
        const updated = await this.cycles.reopen(tx, cycle, {
          actorId,
          operationId: input.requestId,
          occurredAt: new Date(),
          reason: input.reason,
        });
        return { crate: { code: crate.code }, cycle: await this.cycles.toState(updated, tx) };
      },
    );
    return result;
  }

  /**
   * Zrušit oběh: every membership released one by one (each bottle keeps its status and is then
   * outside a crate), the cycle ABORTED. Nothing returns to stock, nothing is re-emptied.
   */
  async abort(
    actorId: string,
    siteId: string,
    crateCode: string,
    input: CycleReasonRequest,
  ): Promise<CycleCorrectionResult> {
    const { result } = await this.operations.run(
      'CYCLE_ABORT',
      input.requestId,
      { actorId, siteId, crateCode, reason: input.reason },
      async (tx) => {
        const { crate, cycle: open } = await this.lockedCycle(tx, crateCode, siteId);
        if (!open) throw this.noCycle();
        if (isHeldByOrder(open.status)) throw crateAllocated(open.status);
        if (open.status === 'FILLED') throw crateReady();
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        let cycle = open;
        for (const member of await this.cycles.activeMembers(tx, cycle.id)) {
          const status = await this.bottles.lockForLabelApplication(tx, member.bottle.id);
          cycle = await this.cycles.releaseMember(tx, cycle, {
            ...step,
            assignmentId: member.id,
            bottleFilled: status === 'FILLED',
            reason: input.reason,
          });
          await this.bottles.removedFromCrateEvent(tx, {
            bottleId: member.bottle.id,
            occurredAt: step.occurredAt,
            actorId,
            crateCycleId: cycle.id,
            operationRequestId: input.requestId,
            crateCode: crate.code,
            reason: input.reason,
          });
        }
        await this.cycles.abort(tx, cycle, { ...step, reason: input.reason });
        return { crate: { code: crate.code }, cycle: null };
      },
    );
    return result;
  }

  // --- helpers ----------------------------------------------------------------------------------

  /** The crate of the site (another site's is "not found") locked, with its open cycle locked. */
  private async lockedCycle(tx: Prisma.TransactionClient, code: string, siteId: string) {
    const found = await this.crates.findOfSite(code, siteId, tx);
    await this.cycles.lockCrate(tx, found.id);
    const crate = await this.cycles.crateById(tx, found.id);
    return { crate, cycle: await this.cycles.openCycle(tx, crate.id, true) };
  }

  private noCycle() {
    return domainError(409, 'CRATE_EMPTY', 'This crate has no open circulation');
  }

  /** A bottle of the site by its code or its scanned QR URL. */
  private async bottleOf(tx: Prisma.TransactionClient, ref: string, siteId: string) {
    let bottle;
    if (/^https?:\/\//i.test(ref)) {
      const scan = classifyScannedQr(ref, this.env.PUBLIC_QR_BASE_URL);
      if (scan.kind !== 'TOKEN') {
        throw domainError(422, 'NOT_AYVO_QR', 'This is not an AYVO QR code of this environment');
      }
      bottle = await this.bottles.findByPublicToken(tx, scan.token);
    } else {
      bottle = await this.bottles.findByCode(tx, ref.toUpperCase());
    }
    if (!bottle || bottle.siteId !== siteId) throw new NotFoundException('Bottle not found');
    return bottle;
  }
}
