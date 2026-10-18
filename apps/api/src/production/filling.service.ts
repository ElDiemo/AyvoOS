import type {
  FillingState,
  FillScanResult,
  FinishCrateRequest,
  FinishCrateResult,
  LabelScanRequest,
  ScanRequest,
  SetLiquidLotRequest,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
import { RecipesService } from '../catalog/recipes.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { formatQuantity, quantity } from '../common/quantity.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { CrateCyclesService, type CycleRecord, isHeldByOrder } from '../crates/crate-cycles.service.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { QrRegistryService } from '../database/qr-registry.service.js';
import type { Prisma, WorkstationSession } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { InventoryService, byLockOrder } from '../inventory/inventory.service.js';
import { StationSessionsService } from '../workstations/station-sessions.service.js';
import type { WorkstationRecord } from '../workstations/workstations.service.js';
import { crateAllocated } from './cycle-corrections.service.js';
import { WeightsService } from '../catalog/weights.service.js';

const notFilling = () => domainError(409, 'WRONG_STATION_MODE', 'This is not a filling station');
const contextChanged = () =>
  domainError(
    409,
    'CONTEXT_CHANGED',
    'The station context changed since this scan; nothing was recorded',
  );

type FillLines = Awaited<ReturnType<RecipesService['stageBomLines']>>;

/**
 * Filling into the same crate (doc 025 A4, owner decisions B2–B5). A filling station (mode +
 * category) loads the crate assembled at labelling (READY_TO_FILL or FILLING); the operator
 * explicitly chooses the liquid lot. Each "Potvrdit naplnění" scan — after the bottle was
 * physically filled and its pump installed — checks that the bottle is an eligible member of THAT
 * crate (never assigns), then in ONE transaction: LABELED_EMPTY → FILLED, the FILLED event with the
 * one liquid lot, the PUMP attachment and the cycle recipe's FILL BOM consumption (liquid from the
 * chosen lot + pump) exactly once; never the body or the label again. Hotovo alone makes a full,
 * completely filled crate FILLED ("Připravená").
 *
 * Lock order (doc 020 §8): operation request → session → crate → cycle → bottle → balances.
 */
@Injectable()
export class FillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly sessions: StationSessionsService,
    private readonly cycles: CrateCyclesService,
    private readonly bottles: BottlesService,
    private readonly recipes: RecipesService,
    private readonly inventory: InventoryService,
    private readonly registry: QrRegistryService,
    private readonly weights: WeightsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- reads ------------------------------------------------------------------------------------

  async state(principal: Principal, sessionId: string): Promise<FillingState> {
    const { session, station } = await this.sessions.readActiveSession(principal, sessionId);
    if (station.mode !== 'FILLING') throw notFilling();
    return this.stateOf(this.prisma, session, station);
  }

  // --- context: the crate and the liquid lot ----------------------------------------------------

  async loadCrate(
    principal: Principal,
    sessionId: string,
    input: ScanRequest,
  ): Promise<FillingState> {
    const token = this.tokenOf(input.scannedValue);
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'STATION_CRATE_LOAD',
      input.requestId,
      { actorId: principal.userId, sessionId, token, mode: 'FILLING' },
      async (tx) => {
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'FILLING') throw notFilling();
        if ((await this.registry.kindOf(token, tx)) !== 'CRATE') {
          throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        }
        const crate = await this.cycles.crateByToken(tx, token);
        if (!crate) throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        if (crate.siteId !== station.siteId) {
          throw domainError(409, 'CRATE_OF_ANOTHER_SITE', 'This crate belongs to another site');
        }
        await this.cycles.lockCrate(tx, crate.id);
        const cycle = await this.cycles.openCycle(tx, crate.id, true);
        this.assertFillable(cycle, station);
        const liquid = this.liquidLine(await this.fillLines(tx, cycle!));
        const lot = session.liquidLotId
          ? await this.inventory.getLot(session.liquidLotId, tx)
          : null;
        await this.sessions.loadCrate(tx, sessionId, crate.id, principal.userId, input.requestId, {
          keepLiquidLot: !!lot && lot.itemId === liquid.itemId,
        });
        const updated = await tx.workstationSession.findUniqueOrThrow({ where: { id: sessionId } });
        return this.stateOf(tx, updated, station);
      },
    );
    return result;
  }

  async setLiquidLot(
    principal: Principal,
    sessionId: string,
    input: SetLiquidLotRequest,
  ): Promise<FillingState> {
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'STATION_LIQUID_LOT',
      input.requestId,
      { actorId: principal.userId, sessionId, liquidLotId: input.liquidLotId },
      async (tx) => {
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'FILLING') throw notFilling();
        if (!session.crateId) {
          throw domainError(409, 'CONTEXT_INCOMPLETE', 'Load the crate first');
        }
        const cycle = await this.cycles.openCycle(tx, session.crateId);
        this.assertFillable(cycle, station);
        const liquid = this.liquidLine(await this.fillLines(tx, cycle!));
        const lot = await this.inventory.getLot(input.liquidLotId, tx);
        // The lot must be the recipe's liquid AND recorded in the station's warehouse (it may be
        // used up there meanwhile): a lot of another warehouse or site is refused like an unknown
        // one — nothing stored, nothing of it returned (PR #24 review A4-R1).
        const local =
          lot &&
          (await tx.inventoryBalance.count({
            where: { lotId: lot.id, locationId: station.locationId },
          })) > 0;
        if (!lot || lot.itemId !== liquid.itemId || !local) {
          throw domainError(
            422,
            'WRONG_LOT',
            'The lot is not a lot of the recipe’s liquid in this station’s warehouse',
          );
        }
        await this.sessions.setLiquidLot(tx, sessionId, lot.id, principal.userId, input.requestId);
        const updated = await tx.workstationSession.findUniqueOrThrow({ where: { id: sessionId } });
        return this.stateOf(tx, updated, station);
      },
    );
    return result;
  }

  // --- the filling scan --------------------------------------------------------------------------

  async scan(
    principal: Principal,
    sessionId: string,
    input: LabelScanRequest,
  ): Promise<FillScanResult> {
    const scan = classifyScannedQr(input.scannedValue, this.env.PUBLIC_QR_BASE_URL);
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
    // Allowed to work at this station NOW — also before a stored result is replayed.
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'FILL_SCAN',
      input.requestId,
      {
        actorId: principal.userId,
        sessionId,
        url: scan.url,
        contextRevision: input.contextRevision,
      },
      async (tx) => {
        // 1. session (locked, re-validated, lease renewed) and its context
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'FILLING') throw notFilling();
        const { crateId, liquidLotId } = session;
        if (!crateId || !liquidLotId) {
          throw domainError(
            409,
            'CONTEXT_INCOMPLETE',
            'Load the crate and choose the liquid lot first',
          );
        }
        if (session.labelingContextRevision !== input.contextRevision) throw contextChanged();

        // 2. crate → 3. cycle (locked)
        const crate = await this.cycles.crateById(tx, crateId);
        await this.cycles.lockCrate(tx, crate.id);
        let cycle = await this.cycles.openCycle(tx, crate.id, true);
        this.assertFillable(cycle, station);

        // 4. bottle (locked): must be an eligible member of THIS crate — never assigned here.
        const kind = await this.registry.kindOf(scan.token, tx);
        if (kind && kind !== 'BOTTLE') {
          throw domainError(422, 'NOT_A_BOTTLE', 'This is not a bottle QR code');
        }
        const bottle = await this.bottles.findByPublicToken(tx, scan.token);
        if (!bottle) throw domainError(422, 'UNKNOWN_LABEL', 'No bottle has this label');
        if (bottle.siteId !== station.siteId) {
          throw domainError(422, 'BOTTLE_OF_ANOTHER_SITE', 'This bottle belongs to another site');
        }
        const status = await this.bottles.lockForLabelApplication(tx, bottle.id);
        if (!(await this.cycles.isActiveMember(tx, cycle!.id, bottle.id))) {
          throw await this.notAMember(tx, bottle.id, status);
        }
        if (status === 'FILLED') {
          // Duplicate scan of a bottle filled in this crate: no write, no consumption.
          const recorded = await this.bottles.filledLot(tx, bottle.id);
          return this.result(
            'ALREADY_FILLED',
            bottle.code,
            crate.code,
            cycle!,
            recorded!.liquidLot!.id,
            station,
            tx,
          );
        }
        if (status !== 'LABELED_EMPTY') {
          throw domainError(409, 'BOTTLE_NOT_FILLABLE', 'This bottle cannot be filled');
        }

        // 5. balances: the cycle recipe's FILL lines — liquid from the chosen lot, pump.
        const lines = await this.fillLines(tx, cycle!);
        const liquid = this.liquidLine(lines);
        const lot = await this.inventory.getLot(liquidLotId, tx);
        if (!lot || lot.itemId !== liquid.itemId) {
          throw domainError(409, 'WRONG_LOT', 'The chosen lot is not a lot of the recipe’s liquid');
        }
        const consumption = lines
          .map((line) => {
            if (line.item.lotTracking !== 'REQUIRED') return { line, lotId: null };
            if (line.id !== liquid.id) {
              throw domainError(409, 'LOT_REQUIRED', `No lot is chosen for ${line.item.code}`);
            }
            return { line, lotId: lot.id };
          })
          .map((c) => ({ ...c, itemId: c.line.itemId, locationId: station.locationId }))
          .sort(byLockOrder);
        for (const c of consumption) {
          const onHand = await this.inventory.lockBalance(tx, c);
          if (onHand.lessThan(c.line.quantity)) {
            throw c.line.id === liquid.id
              ? domainError(409, 'LOT_EXHAUSTED', 'The chosen liquid lot does not cover one bottle')
              : domainError(409, 'INSUFFICIENT_STOCK', `Not enough ${c.line.item.code} in stock`);
          }
        }

        // 6. writes — one transaction, one operation id
        const occurredAt = new Date();
        const { eventId } = await this.bottles.fillInTransaction(tx, {
          bottleId: bottle.id,
          occurredAt,
          actorId: principal.userId,
          crateCycleId: cycle!.id,
          workstationSessionId: sessionId,
          operationRequestId: input.requestId,
          liquidLotId: lot.id,
          crateCode: crate.code,
        });
        await this.inventory.postMovements(
          tx,
          consumption.map((c) => ({
            itemId: c.itemId,
            unitId: c.line.unitId,
            locationId: c.locationId,
            lotId: c.lotId,
            quantityDelta: c.line.quantity.negated(),
            type: 'FILL' as const,
            bottleEventId: eventId,
            bomLineId: c.line.id,
            occurredAt,
            requestId: input.requestId,
          })),
        );
        cycle = await this.cycles.memberFilled(tx, cycle!, {
          actorId: principal.userId,
          operationId: input.requestId,
          occurredAt,
        });
        return this.result('FILLED', bottle.code, crate.code, cycle, lot.id, station, tx);
      },
    );
    return result;
  }

  // --- Hotovo -----------------------------------------------------------------------------------

  /**
   * Hotovo: only a FILLING crate with members = filled = capacity becomes FILLED ("Připravená");
   * never derived from counts by itself (ADR 0025). The crate then leaves the station.
   */
  async finish(
    principal: Principal,
    sessionId: string,
    input: FinishCrateRequest,
  ): Promise<FinishCrateResult> {
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'CRATE_FINISH',
      input.requestId,
      { actorId: principal.userId, sessionId, contextRevision: input.contextRevision },
      async (tx) => {
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'FILLING') throw notFilling();
        if (!session.crateId) throw domainError(409, 'CONTEXT_INCOMPLETE', 'Load the crate first');
        if (session.labelingContextRevision !== input.contextRevision) throw contextChanged();
        const crate = await this.cycles.crateById(tx, session.crateId);
        await this.cycles.lockCrate(tx, crate.id);
        const cycle = await this.cycles.openCycle(tx, crate.id, true);
        this.assertFillable(cycle, station);
        if (
          cycle!.status !== 'FILLING' ||
          cycle!.memberCount !== cycle!.capacity ||
          cycle!.filledCount !== cycle!.capacity
        ) {
          throw domainErrorWithDetails(
            409,
            'CRATE_NOT_COMPLETE',
            'Hotovo needs a full crate with every bottle filled',
            {
              memberCount: cycle!.memberCount,
              filledCount: cycle!.filledCount,
              capacity: cycle!.capacity,
            },
          );
        }
        const occurredAt = new Date();
        const finished = await this.cycles.finish(tx, cycle!, {
          actorId: principal.userId,
          operationId: input.requestId,
          occurredAt,
        });
        // The weight references available now (doc 025 §10); unknown stays unknown, never blocks.
        await this.weights.snapshotHotovo(tx, finished, input.requestId, occurredAt);
        await this.sessions.unloadCrate(tx, sessionId);
        return { crate: { code: crate.code }, cycle: await this.cycles.toState(finished, tx) };
      },
    );
    return result;
  }

  // --- helpers ----------------------------------------------------------------------------------

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

  /** May the caller work at the session's filling station right now (no lock, no write)? */
  private async authorize(principal: Principal, sessionId: string): Promise<void> {
    const { station } = await this.sessions.readActiveSession(principal, sessionId);
    if (station.mode !== 'FILLING') throw notFilling();
  }

  /** The crate is filled only while READY_TO_FILL or FILLING, in the station's category. */
  private assertFillable(cycle: CycleRecord | null, station: WorkstationRecord): void {
    if (!cycle) {
      throw domainError(
        409,
        'CRATE_EMPTY',
        'This crate holds no labelled bottles: bottles are put into it at labelling',
      );
    }
    if (cycle.status === 'OPEN_ASSEMBLY') {
      throw domainErrorWithDetails(
        409,
        'CRATE_NOT_READY',
        'This crate is still being assembled at labelling',
        { memberCount: cycle.memberCount, capacity: cycle.capacity },
      );
    }
    if (isHeldByOrder(cycle.status)) throw crateAllocated();
    if (cycle.status === 'FILLED') {
      throw domainError(409, 'CRATE_ALREADY_FILLED', 'This crate is already finished (Hotovo)');
    }
    if (cycle.categoryCode !== station.categoryCode) {
      throw domainError(
        422,
        'WRONG_CATEGORY',
        'This crate holds another product category than this station fills',
      );
    }
  }

  /** Why a scanned bottle is not a member of the loaded crate — never moved silently. */
  private async notAMember(tx: Prisma.TransactionClient, bottleId: string, status: string) {
    if (status === 'CREATED') {
      return domainError(409, 'BOTTLE_NOT_LABELED', 'This bottle has no label yet');
    }
    if (!(await this.bottles.productBinding(tx, bottleId))) {
      // Labelled before labelling into crates existed (owner B3): refused, nothing changed.
      return domainError(
        409,
        'BOTTLE_NOT_BOUND',
        'This bottle was labelled before crates were recorded and has no product binding',
      );
    }
    const elsewhere = await this.cycles.activeMembership(tx, bottleId);
    if (elsewhere) {
      return domainErrorWithDetails(
        409,
        'IN_ANOTHER_CRATE',
        `This bottle belongs to crate ${elsewhere.cycle.crate.code}`,
        { crate: elsewhere.cycle.crate.code },
      );
    }
    return domainError(409, 'NOT_IN_THIS_CRATE', 'This bottle is in no crate');
  }

  private fillLines(db: Prisma.TransactionClient, cycle: CycleRecord): Promise<FillLines> {
    return this.recipes.stageBomLines(db, cycle.recipeVersionId, 'FILL');
  }

  /** The recipe's liquid line; filling needs a lot-tracked liquid and a pump (owner B5). */
  private liquidLine(lines: FillLines): FillLines[number] {
    const liquid = lines.find((l) => l.item.kind === 'BULK_LIQUID');
    if (!liquid || !lines.some((l) => l.item.kind === 'PUMP')) {
      throw domainError(409, 'RECIPE_INCOMPLETE', 'The recipe has no liquid or pump to fill');
    }
    if (liquid.item.lotTracking !== 'REQUIRED') {
      throw domainError(
        409,
        'LIQUID_NOT_LOT_TRACKED',
        'The recipe’s liquid is not lot-tracked: a bottle must name its liquid lot',
      );
    }
    return liquid;
  }

  private async onHandAt(db: Prisma.TransactionClient, lotId: string, locationId: string) {
    const balance = await db.inventoryBalance.findFirst({
      where: { lotId, locationId },
      select: { onHand: true },
    });
    return formatQuantity(balance?.onHand ?? quantity(0));
  }

  private async result(
    outcome: FillScanResult['outcome'],
    bottleCode: string,
    crateCode: string,
    cycle: CycleRecord,
    lotId: string,
    station: WorkstationRecord,
    db: Prisma.TransactionClient,
  ): Promise<FillScanResult> {
    const lot = await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } });
    return {
      outcome,
      bottle: { code: bottleCode },
      crate: { code: crateCode },
      cycle: await this.cycles.toState(cycle, db),
      liquidLot: { code: lot.code, onHand: await this.onHandAt(db, lot.id, station.locationId) },
    };
  }

  private async stateOf(
    db: Prisma.TransactionClient,
    session: WorkstationSession,
    station: WorkstationRecord,
  ): Promise<FillingState> {
    let crate: FillingState['crate'] = null;
    let liquidItem: FillingState['liquidItem'] = null;
    let pumpItem: FillingState['pumpItem'] = null;
    let lots: FillingState['lots'] = [];
    if (session.crateId) {
      const c = await this.cycles.crateById(db, session.crateId);
      const open = await this.cycles.openCycle(db, c.id);
      crate = {
        code: c.code,
        capacity: c.crateType.capacity,
        cycle: open ? await this.cycles.toState(open, db) : null,
      };
      if (open) {
        const lines = await this.fillLines(db, open);
        const liquid = lines.find((l) => l.item.kind === 'BULK_LIQUID');
        const pump = lines.find((l) => l.item.kind === 'PUMP');
        if (liquid) {
          const unit = await db.inventoryUnit.findUniqueOrThrow({ where: { id: liquid.unitId } });
          liquidItem = {
            code: liquid.item.code,
            name: liquid.item.name,
            unitCode: unit.code,
            quantity: formatQuantity(liquid.quantity),
          };
          const balances = await db.inventoryBalance.findMany({
            where: {
              locationId: station.locationId,
              itemId: liquid.itemId,
              lotId: { not: null },
              onHand: { gt: 0 },
            },
            include: { lot: { select: { id: true, code: true } } },
            orderBy: { lot: { code: 'asc' } },
          });
          lots = balances.map((b) => ({
            id: b.lot!.id,
            code: b.lot!.code,
            onHand: formatQuantity(b.onHand),
          }));
        }
        if (pump) pumpItem = { code: pump.item.code, name: pump.item.name };
      }
    }
    const lot = session.liquidLotId
      ? await db.inventoryLot.findUnique({ where: { id: session.liquidLotId } })
      : null;
    return {
      contextRevision: session.labelingContextRevision,
      category: station.category ?? { code: '', name: '' },
      crate,
      liquidItem,
      pumpItem,
      liquidLot: lot
        ? {
            id: lot.id,
            code: lot.code,
            onHand: await this.onHandAt(db, lot.id, station.locationId),
          }
        : null,
      lots,
    };
  }
}
