import type {
  LabelingOptions,
  LabelingState,
  LabelScanRequest,
  LabelScanResult,
  ScanRequest,
  SetLabelingContextRequest,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
import { ProductLabelApprovalsService } from '../catalog/product-label-approvals.service.js';
import { RecipesService } from '../catalog/recipes.service.js';
import { domainError } from '../common/domain-error.js';
import { formatQuantity, quantity } from '../common/quantity.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { CrateCyclesService, type CycleRecord } from '../crates/crate-cycles.service.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { QrRegistryService } from '../database/qr-registry.service.js';
import type { Prisma, WorkstationSession } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { InventoryService, byLockOrder } from '../inventory/inventory.service.js';
import { LabelPrintJobsService } from '../label-production/label-print-jobs.service.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';
import { StationSessionsService } from '../workstations/station-sessions.service.js';
import type { WorkstationRecord } from '../workstations/workstations.service.js';

const notLabeling = () => domainError(409, 'WRONG_STATION_MODE', 'This is not a labelling station');
const contextIncomplete = () =>
  domainError(
    409,
    'CONTEXT_INCOMPLETE',
    'Choose the product, label design, bottle lot and crate first',
  );

/**
 * Labelling into crates (doc 025 A3, owner decisions B1–B4). At a labelling station the operator
 * chooses once: product (its ACTIVE recipe version), an approved label design and the source lot of
 * new bottles, then loads a crate. Each "Potvrdit nalepení" scan — after the label is physically
 * applied — in ONE transaction: CREATED → LABELED_EMPTY, LABEL_APPLIED, the LABEL attachment, the
 * permanent product binding, the consumption of the cycle recipe's LABEL_APPLICATION BOM (bottle
 * body from the chosen lot + label) exactly once, ASSIGNED_TO_CRATE and the membership (the
 * capacity-th member makes the crate READY_TO_FILL). Duplicates write nothing; a bottle already
 * labelled elsewhere (or before this change, B3) is refused, never moved silently.
 *
 * Lock order (doc 020 §8): operation request → session → crate → cycle → bottle → balances.
 */
@Injectable()
export class LabelingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly sessions: StationSessionsService,
    private readonly cycles: CrateCyclesService,
    private readonly bottles: BottlesService,
    private readonly printJobs: LabelPrintJobsService,
    private readonly recipes: RecipesService,
    private readonly approvals: ProductLabelApprovalsService,
    private readonly labels: LabelTemplatesService,
    private readonly inventory: InventoryService,
    private readonly registry: QrRegistryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- reads ------------------------------------------------------------------------------------

  async options(principal: Principal, sessionId: string): Promise<LabelingOptions> {
    const { station } = await this.sessions.readActiveSession(principal, sessionId);
    if (station.mode !== 'LABELING') throw notLabeling();
    const products = await this.prisma.product.findMany({
      where: { status: 'ACTIVE' },
      include: { category: true },
      orderBy: { code: 'asc' },
    });
    const designs = await this.approvals.openDesigns(products.map((p) => p.id));
    const refs = await this.labels.getVersionRefs([...designs.values()].flat());
    const result: LabelingOptions['products'] = [];
    const bottleItemIds = new Set<string>();
    for (const p of products) {
      const recipe = await this.recipes.activeVersion(this.prisma, p.id);
      if (!recipe) continue;
      const lines = await this.recipes.stageBomLines(this.prisma, recipe.id, 'LABEL_APPLICATION');
      const bottle = lines.find((l) => l.item.kind === 'NEW_BOTTLE');
      if (!bottle) continue;
      const label = lines.find((l) => l.item.kind === 'LABEL_MEDIA');
      bottleItemIds.add(bottle.item.id);
      result.push({
        code: p.code,
        name: p.name,
        category: { code: p.category.code, name: p.category.name },
        recipeVersion: recipe.version,
        designs: (designs.get(p.id) ?? []).map((id) => refs.get(id)!).filter(Boolean),
        bottleItem: { code: bottle.item.code, name: bottle.item.name },
        labelItem: label ? { code: label.item.code, name: label.item.name } : null,
      });
    }
    const balances = await this.prisma.inventoryBalance.findMany({
      where: {
        locationId: station.locationId,
        itemId: { in: [...bottleItemIds] },
        lotId: { not: null },
        onHand: { gt: 0 },
      },
      include: { lot: { select: { id: true, code: true } }, item: { select: { code: true } } },
      orderBy: { lot: { code: 'asc' } },
    });
    return {
      products: result,
      lots: balances.map((b) => ({
        id: b.lot!.id,
        code: b.lot!.code,
        itemCode: b.item.code,
        onHand: formatQuantity(b.onHand),
      })),
    };
  }

  async state(principal: Principal, sessionId: string): Promise<LabelingState> {
    const { session, station } = await this.sessions.readActiveSession(principal, sessionId);
    if (station.mode !== 'LABELING') throw notLabeling();
    return this.stateOf(this.prisma, session, station);
  }

  // --- context ----------------------------------------------------------------------------------

  async setContext(
    principal: Principal,
    sessionId: string,
    input: SetLabelingContextRequest,
  ): Promise<LabelingState> {
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'STATION_LABELING_CONTEXT',
      input.requestId,
      { actorId: principal.userId, sessionId, ...input, requestId: undefined },
      async (tx) => {
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'LABELING') throw notLabeling();
        const product = await tx.product.findUnique({ where: { code: input.productCode } });
        if (!product || product.status !== 'ACTIVE') {
          throw domainError(422, 'UNKNOWN_PRODUCT', 'Unknown or archived product');
        }
        const recipe = await this.recipes.activeVersion(tx, product.id);
        if (!recipe) throw domainError(409, 'NO_ACTIVE_RECIPE', 'The product has no active recipe');
        if (!(await this.approvals.isOpen(tx, product.id, input.labelTemplateVersionId))) {
          throw domainError(
            422,
            'DESIGN_NOT_APPROVED',
            'This label design is not approved for the product',
          );
        }
        const lines = await this.recipes.stageBomLines(tx, recipe.id, 'LABEL_APPLICATION');
        const bottleLine = lines.find((l) => l.item.kind === 'NEW_BOTTLE');
        const lot = await this.inventory.getLot(input.sourceLotId, tx);
        if (!lot || !bottleLine || lot.itemId !== bottleLine.itemId) {
          throw domainError(422, 'WRONG_LOT', 'The lot is not a lot of the recipe’s new bottles');
        }
        // A loaded crate stays only if its open cycle (if any) has the same product and design.
        let keepCrate = false;
        if (session.crateId) {
          const open = await this.cycles.openCycle(tx, session.crateId);
          keepCrate =
            !open ||
            (open.status === 'OPEN_ASSEMBLY' &&
              open.productId === product.id &&
              open.labelTemplateVersionId === input.labelTemplateVersionId);
        }
        await this.sessions.setLabelingContext(tx, sessionId, principal.userId, input.requestId, {
          productId: product.id,
          recipeVersionId: recipe.id,
          labelTemplateVersionId: input.labelTemplateVersionId,
          sourceLotId: lot.id,
          keepCrate,
        });
        const updated = await tx.workstationSession.findUniqueOrThrow({ where: { id: sessionId } });
        return this.stateOf(tx, updated, station);
      },
    );
    return result;
  }

  async loadCrate(
    principal: Principal,
    sessionId: string,
    input: ScanRequest,
  ): Promise<LabelingState> {
    const token = this.tokenOf(input.scannedValue);
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'STATION_CRATE_LOAD',
      input.requestId,
      { actorId: principal.userId, sessionId, token },
      async (tx) => {
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'LABELING') throw notLabeling();
        if (!session.productId || !session.labelTemplateVersionId) throw contextIncomplete();
        const kind = await this.registry.kindOf(token, tx);
        if (kind !== 'CRATE') {
          throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        }
        const crate = await this.cycles.crateByToken(tx, token);
        if (!crate) throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        if (crate.siteId !== station.siteId) {
          throw domainError(409, 'CRATE_OF_ANOTHER_SITE', 'This crate belongs to another site');
        }
        await this.cycles.lockCrate(tx, crate.id);
        const open = await this.cycles.openCycle(tx, crate.id, true);
        this.assertAssemblable(open, session);
        // An empty crate will start a new cycle: it needs the current recipe and its exact crate
        // type (an open cycle keeps its own snapshot, whose type is that crate's).
        if (!open) await this.assertNewCycleAllowed(tx, session, crate.crateTypeId);
        await this.sessions.loadCrate(tx, sessionId, crate.id, principal.userId, input.requestId);
        const updated = await tx.workstationSession.findUniqueOrThrow({ where: { id: sessionId } });
        return this.stateOf(tx, updated, station);
      },
    );
    return result;
  }

  // --- the labelling scan ------------------------------------------------------------------------

  async scan(
    principal: Principal,
    sessionId: string,
    input: LabelScanRequest,
  ): Promise<LabelScanResult> {
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
    // The caller must be allowed to work at this station NOW — also before a stored result is
    // replayed (operations.run skips the callback for a replay).
    await this.authorize(principal, sessionId);
    const { result } = await this.operations.run(
      'LABEL_SCAN',
      input.requestId,
      {
        actorId: principal.userId,
        sessionId,
        url: scan.url,
        contextRevision: input.contextRevision,
      },
      async (tx) => {
        // 1. session (locked, re-validated, lease renewed) and its complete context
        const { session, station } = await this.sessions.requireActiveSession(
          tx,
          principal,
          sessionId,
        );
        if (station.mode !== 'LABELING') throw notLabeling();
        const { productId, recipeVersionId, labelTemplateVersionId, sourceLotId, crateId } =
          session;
        if (!productId || !recipeVersionId || !labelTemplateVersionId || !sourceLotId || !crateId) {
          throw contextIncomplete();
        }
        // The scan belongs to the context it was made in; never to a newer one (other crate,
        // product, design or lot) — e.g. a delayed retry after the operator changed the crate.
        if (session.labelingContextRevision !== input.contextRevision) {
          throw domainError(
            409,
            'CONTEXT_CHANGED',
            'The station context changed since this scan; nothing was recorded',
          );
        }
        // 2. crate → 3. cycle (locked)
        const crate = await this.cycles.crateById(tx, crateId);
        await this.cycles.lockCrate(tx, crate.id);
        let cycle = await this.cycles.openCycle(tx, crate.id, true);
        this.assertAssemblable(cycle, session);

        // 4. bottle (locked)
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
        if (status !== 'CREATED') {
          // Already labelled: in THIS crate it is a duplicate scan (no write, no consumption).
          if (cycle && (await this.cycles.isActiveMember(tx, cycle.id, bottle.id))) {
            return this.result(
              'ALREADY_APPLIED',
              bottle.code,
              crate.code,
              cycle,
              sourceLotId,
              station,
              tx,
            );
          }
          const elsewhere = await this.cycles.activeMembership(tx, bottle.id);
          if (elsewhere) {
            throw domainError(
              409,
              'IN_ANOTHER_CRATE',
              `This bottle is already in crate ${elsewhere.cycle.crate.code}`,
            );
          }
          // Labelled before this change (no crate, no binding — owner B3) or otherwise used.
          throw domainError(409, 'ALREADY_LABELED', 'This bottle is already labelled');
        }

        // The label: printed by a completed job, with the chosen design, approved for the product.
        const label = await this.printJobs.latestCompletedLabel(tx, bottle.id, scan.url);
        if (!label) {
          throw domainError(
            422,
            'LABEL_NOT_PRINTED',
            'This label was never printed by a completed print job',
          );
        }
        const printed = await tx.labelPrintJob.findUniqueOrThrow({
          where: { id: label.printJobId },
          select: { labelTemplateVersionId: true },
        });
        if (printed.labelTemplateVersionId !== labelTemplateVersionId) {
          throw domainError(
            422,
            'WRONG_LABEL_DESIGN',
            'This label has another design than the chosen one',
          );
        }
        if (!(await this.approvals.isOpen(tx, productId, labelTemplateVersionId))) {
          throw domainError(
            409,
            'DESIGN_NOT_APPROVED',
            'This label design is no longer approved for the product',
          );
        }

        // The cycle: opened by its first bottle with the session's snapshot (owner B2).
        const occurredAt = new Date();
        const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
        if (!cycle) {
          await this.assertNewCycleAllowed(tx, session, crate.crateTypeId);
          cycle = await this.cycles.createCycle(tx, {
            crate: {
              id: crate.id,
              siteId: crate.siteId,
              crateTypeId: crate.crateTypeId,
              capacity: crate.crateType.capacity,
            },
            productId,
            categoryCode: product.categoryCode,
            recipeVersionId,
            labelTemplateVersionId,
            actorId: principal.userId,
            operationId: input.requestId,
            occurredAt,
          });
        }

        // 5. balances: the cycle recipe's LABEL_APPLICATION lines — body from the chosen lot.
        const lines = await this.recipes.stageBomLines(
          tx,
          cycle.recipeVersionId,
          'LABEL_APPLICATION',
        );
        const lot = await this.inventory.getLot(sourceLotId, tx);
        const consumption = lines
          .map((line) => {
            if (line.item.lotTracking !== 'REQUIRED') return { line, lotId: null };
            if (line.item.kind !== 'NEW_BOTTLE' || !lot || lot.itemId !== line.itemId) {
              throw domainError(409, 'LOT_REQUIRED', `No lot is chosen for ${line.item.code}`);
            }
            return { line, lotId: lot.id };
          })
          .map((c) => ({ ...c, itemId: c.line.itemId, locationId: station.locationId }))
          .sort(byLockOrder);
        if (!consumption.some((c) => c.line.item.kind === 'NEW_BOTTLE')) {
          throw domainError(409, 'RECIPE_INCOMPLETE', 'The recipe has no bottle body to consume');
        }
        for (const c of consumption) {
          const onHand = await this.inventory.lockBalance(tx, c);
          if (onHand.lessThan(c.line.quantity)) {
            throw c.line.item.kind === 'NEW_BOTTLE'
              ? domainError(409, 'LOT_EXHAUSTED', 'The chosen lot has no new bottle left')
              : domainError(409, 'INSUFFICIENT_STOCK', `Not enough ${c.line.item.code} in stock`);
          }
        }

        // 6. writes — one transaction, one operation id
        const common = {
          actorId: principal.userId,
          crateCycleId: cycle.id,
          workstationSessionId: sessionId,
          operationRequestId: input.requestId,
        };
        const { eventId } = await this.bottles.applyLabelInTransaction(tx, {
          bottleId: bottle.id,
          occurredAt,
          labelQrUrl: scan.url,
          printJobId: label.printJobId,
          printJobPosition: label.position,
          ...common,
        });
        await this.inventory.postMovements(
          tx,
          consumption.map((c) => ({
            itemId: c.itemId,
            unitId: c.line.unitId,
            locationId: c.locationId,
            lotId: c.lotId,
            quantityDelta: c.line.quantity.negated(),
            type: 'LABEL_APPLICATION' as const,
            bottleEventId: eventId,
            bomLineId: c.line.id,
            occurredAt,
            requestId: input.requestId,
          })),
        );
        await this.bottles.bindProduct(tx, {
          bottleId: bottle.id,
          productId,
          categoryCode: product.categoryCode,
          labelTemplateVersionId,
          labelAppliedEventId: eventId,
          crateCycleId: cycle.id,
          operationRequestId: input.requestId,
          boundAt: occurredAt,
        });
        const assigned = await this.bottles.assignedToCrateEvent(tx, {
          bottleId: bottle.id,
          occurredAt,
          crateCode: crate.code,
          ...common,
        });
        cycle = await this.cycles.addMember(tx, cycle, {
          bottleId: bottle.id,
          assignedEventId: assigned.eventId,
          actorId: principal.userId,
          operationId: input.requestId,
          occurredAt,
        });
        return this.result('APPLIED', bottle.code, crate.code, cycle, sourceLotId, station, tx);
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

  /** May the caller work at the session's labelling station right now (no lock, no write)? */
  private async authorize(principal: Principal, sessionId: string): Promise<void> {
    const { station } = await this.sessions.readActiveSession(principal, sessionId);
    if (station.mode !== 'LABELING') throw notLabeling();
  }

  /**
   * A NEW cycle starts only with the product's current ACTIVE recipe of an active product (a
   * context chosen earlier may be stale — refused, never silently used, owner B2) and only in a
   * crate of exactly the recipe's crate type (same category is not enough).
   */
  private async assertNewCycleAllowed(
    tx: Prisma.TransactionClient,
    session: Pick<WorkstationSession, 'productId' | 'recipeVersionId'>,
    crateTypeId: string,
  ): Promise<void> {
    const product = await tx.product.findUniqueOrThrow({ where: { id: session.productId! } });
    const active = await this.recipes.activeVersion(tx, product.id);
    if (product.status !== 'ACTIVE' || !active || active.id !== session.recipeVersionId) {
      throw domainError(
        409,
        'CONTEXT_STALE',
        'The product or its active recipe changed: choose the labelling context again',
      );
    }
    if ((await this.recipes.crateTypeOf(tx, active.id)) !== crateTypeId) {
      throw domainError(
        422,
        'CRATE_TYPE_MISMATCH',
        'This crate type is not the recipe\u2019s crate type',
      );
    }
  }

  /** A crate accepts labelled bottles only while assembling the same product and design. */
  private assertAssemblable(
    open: CycleRecord | null,
    session: Pick<WorkstationSession, 'productId' | 'labelTemplateVersionId'>,
  ): void {
    if (!open) return;
    if (open.status !== 'OPEN_ASSEMBLY') {
      throw domainError(
        409,
        'CRATE_FULL',
        'This crate is not assembling (it is full or in filling)',
      );
    }
    if (
      open.productId !== session.productId ||
      open.labelTemplateVersionId !== session.labelTemplateVersionId
    ) {
      throw domainError(
        409,
        'CRATE_INCOMPATIBLE',
        'This crate holds another product or label design; one crate never mixes them',
      );
    }
  }

  private async result(
    outcome: LabelScanResult['outcome'],
    bottleCode: string,
    crateCode: string,
    cycle: CycleRecord,
    sourceLotId: string,
    station: WorkstationRecord,
    db: Prisma.TransactionClient,
  ): Promise<LabelScanResult> {
    const lot = await db.inventoryLot.findUniqueOrThrow({ where: { id: sourceLotId } });
    const onHand = await db.inventoryBalance.findFirst({
      where: { lotId: sourceLotId, locationId: station.locationId },
      select: { onHand: true },
    });
    return {
      outcome,
      bottle: { code: bottleCode },
      crate: { code: crateCode },
      cycle: await this.cycles.toState(cycle, db),
      sourceLot: { code: lot.code, onHand: formatQuantity(onHand?.onHand ?? quantity(0)) },
    };
  }

  private async stateOf(
    db: Prisma.TransactionClient,
    session: WorkstationSession,
    station: WorkstationRecord,
  ): Promise<LabelingState> {
    const product = session.productId
      ? await db.product.findUnique({
          where: { id: session.productId },
          include: { category: true },
        })
      : null;
    const recipe = session.recipeVersionId
      ? await db.recipeVersion.findUnique({ where: { id: session.recipeVersionId } })
      : null;
    const design = session.labelTemplateVersionId
      ? ((await this.labels.getVersionRefs([session.labelTemplateVersionId], db)).get(
          session.labelTemplateVersionId,
        ) ?? null)
      : null;
    const lot = session.sourceLotId
      ? await db.inventoryLot.findUnique({ where: { id: session.sourceLotId } })
      : null;
    const lotOnHand = lot
      ? await db.inventoryBalance.findFirst({
          where: { lotId: lot.id, locationId: station.locationId },
          select: { onHand: true },
        })
      : null;
    let crate: LabelingState['crate'] = null;
    if (session.crateId) {
      const c = await this.cycles.crateById(db, session.crateId);
      const open = await this.cycles.openCycle(db, c.id);
      crate = {
        code: c.code,
        capacity: c.crateType.capacity,
        cycle: open ? await this.cycles.toState(open, db) : null,
      };
    }
    return {
      contextRevision: session.labelingContextRevision,
      product: product
        ? {
            code: product.code,
            name: product.name,
            category: { code: product.category.code, name: product.category.name },
          }
        : null,
      recipeVersion: recipe?.version ?? null,
      design,
      sourceLot: lot
        ? { id: lot.id, code: lot.code, onHand: formatQuantity(lotOnHand?.onHand ?? quantity(0)) }
        : null,
      crate,
    };
  }
}
