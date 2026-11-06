import { createHash } from 'node:crypto';
import type {
  CloseOutReturnIssueRequest,
  EmptyReturnLineRequest,
  IdentifyReturnIssueRequest,
  OpenReturnReceiptRequest,
  ReturnBottleScanRequest,
  ReturnBottleScanResult,
  ReturnCrateScanResult,
  ReturnHotelOption,
  ReturnIssueKind,
  ReturnIssueResult,
  ReturnIssueSummary,
  ReturnLineDetail,
  ReturnLineResult,
  ReturnPumpCountRequest,
  ReturnReceiptDetail,
  ReturnReceiptList,
  ReturnReceiptSummary,
  ReturnRequest,
  ReturnScanRequest,
  ReturnsOverview,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
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
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { OrderReturnsService } from '../orders/order-returns.service.js';

type Tx = Prisma.TransactionClient;
type Outcome = 'RETURNED' | 'RETIRED';

/** Issues that stand for one physical piece of their line (doc 047 §4.8). */
const PIECE_KINDS: ReturnIssueKind[] = [
  'UNREADABLE',
  'NOT_DELIVERED',
  'NOT_IN_CIRCULATION',
  'OTHER_SITE',
];
/** Piece issues that an identification can resolve (OTHER_SITE only WRITTEN_OFF, §4.6). */
const IDENTIFIABLE: ReturnIssueKind[] = ['UNREADABLE', 'NOT_DELIVERED', 'NOT_IN_CIRCULATION'];
const SHIPPED = ['DELIVERED', 'RETURNED', 'CLOSED'];

const notFound = () => domainError(404, 'RETURN_RECEIPT_NOT_FOUND', 'No such return receipt');
const issueNotFound = () => domainError(404, 'RETURN_ISSUE_NOT_FOUND', 'No such return issue');
const receiptClosed = () =>
  domainError(409, 'RECEIPT_CLOSED', 'This return receipt is closed: use a new receipt');
const lineEmptied = () =>
  domainError(409, 'LINE_EMPTIED', 'This container was already emptied (Vyprázdněno)');
const concurrentChange = () =>
  domainError(409, 'CONCURRENT_CHANGE', 'The bottle changed meanwhile: scan it again');
const issueResolved = () =>
  domainError(409, 'ISSUE_RESOLVED', 'This issue was already resolved otherwise');

interface LineAnchor {
  id: string;
  scannedAt: Date;
  receiptCode: string;
}
interface IssueRow {
  id: string;
  code: string;
  kind: ReturnIssueKind;
  bottleId: string | null;
  lineId: string;
}

/**
 * Příjem vratek R1 (doc 047 §4, owner 2026-11-06). Every operation runs in one transaction,
 * idempotent per requestId with the receipt and its line or issue in the payload (§4.6 step 0).
 * Lock order: operation request → receipt (FOR SHARE for scans, FOR UPDATE for the crate scan,
 * Vyprázdněno and closing) → crate → cycle → bottle → issue (last) → code counter. A refusal
 * that records an issue (NOT_DELIVERED, NOT_IN_CIRCULATION, OTHER_SITE) returns its committed
 * result instead of throwing, so the issue is kept and a replay adds no second piece.
 */
@Injectable()
export class ReturnReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly registry: QrRegistryService,
    private readonly cycles: CrateCyclesService,
    private readonly bottles: BottlesService,
    private readonly hotels: HotelsService,
    private readonly orderReturns: OrderReturnsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- reads ------------------------------------------------------------------------------------

  async list(site: SiteContext): Promise<ReturnReceiptList> {
    const rows = await this.prisma.returnReceipt.findMany({
      where: { siteId: site.siteId },
      orderBy: { serial: 'desc' },
      take: 100,
      select: { id: true },
    });
    const items: ReturnReceiptSummary[] = [];
    for (const r of rows) items.push(await this.summary(this.prisma, r.id));
    return { items };
  }

  async hotelOptions(site: SiteContext): Promise<ReturnHotelOption[]> {
    return (await this.hotels.list(site.siteId)).map((h) => ({ code: h.code, name: h.name }));
  }

  async detail(site: SiteContext, code: string): Promise<ReturnReceiptDetail> {
    const receipt = await this.receiptInSite(code, site.siteId);
    return this.detailOf(this.prisma, receipt.id);
  }

  async overview(site: SiteContext): Promise<ReturnsOverview> {
    const waiting = await this.prisma.bottle.findMany({
      where: { siteId: site.siteId, status: 'RETURNED' },
      select: {
        code: true,
        events: {
          where: { type: { in: ['SORTED', 'CORRECTION'] } },
          orderBy: { id: 'desc' },
          take: 1,
          select: {
            occurredAt: true,
            returnLine: { select: { receipt: { select: { code: true } } } },
          },
        },
      },
      orderBy: { serial: 'asc' },
      take: 500,
    });
    const issues = await this.prisma.returnReceiptIssue.findMany({
      where: {
        resolvedAt: null,
        kind: { not: 'COUNT_MISMATCH' },
        receipt: { siteId: site.siteId },
      },
      orderBy: { serial: 'asc' },
      take: 500,
      select: issueSelect,
    });
    return {
      waitingForWash: waiting.map((b) => ({
        bottleCode: b.code,
        since: b.events[0]?.occurredAt.toISOString() ?? '',
        receipt: b.events[0]?.returnLine?.receipt.code ?? '',
      })),
      openIssues: issues.map(toIssue),
    };
  }

  // --- receipt ----------------------------------------------------------------------------------

  async open(
    principal: Principal,
    site: SiteContext,
    input: OpenReturnReceiptRequest,
  ): Promise<ReturnReceiptDetail> {
    const { result } = await this.operations.run(
      'RETURN_RECEIPT_OPEN',
      input.requestId,
      { actorId: principal.userId, siteId: site.siteId, hotelCode: input.hotelCode },
      async (tx) => {
        let hotelId: string | null = null;
        if (input.hotelCode) {
          const hotel = await this.hotels.byCode(input.hotelCode, tx);
          if (!hotel || hotel.fulfillmentSiteId !== site.siteId) {
            throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel served by this site');
          }
          hotelId = hotel.id;
        }
        const { first: serial } = await allocateSerials(tx, 'return_receipt', 1);
        const receipt = await tx.returnReceipt.create({
          data: {
            serial,
            code: formatCode(CODE_PREFIX.returnReceipt, serial),
            siteId: site.siteId,
            hotelId,
            openedBy: principal.userId,
            openOperationId: input.requestId,
          },
          select: { id: true },
        });
        return (await this.detailOf(tx, receipt.id)) as unknown as Prisma.InputJsonValue;
      },
    );
    return result as unknown as ReturnReceiptDetail;
  }

  async close(
    principal: Principal,
    site: SiteContext,
    code: string,
    input: ReturnRequest,
  ): Promise<ReturnReceiptDetail> {
    const receipt = await this.receiptInSite(code, site.siteId);
    const { result } = await this.operations.run(
      'RETURN_RECEIPT_CLOSE',
      input.requestId,
      { actorId: principal.userId, siteId: site.siteId, receiptId: receipt.id },
      async (tx) => {
        if ((await this.lockReceipt(tx, receipt.id, 'UPDATE')) !== 'OPEN') throw receiptClosed();
        const open = await tx.returnReceiptLine.count({
          where: { receiptId: receipt.id, emptiedAt: null },
        });
        if (open > 0) {
          throw domainErrorWithDetails(
            409,
            'LINES_NOT_EMPTIED',
            'Every container must be emptied before the receipt is closed',
            { lines: open },
          );
        }
        await tx.returnReceipt.update({
          where: { id: receipt.id },
          data: {
            state: 'CLOSED',
            closedAt: new Date(),
            closedBy: principal.userId,
            closeOperationId: input.requestId,
          },
        });
        return (await this.detailOf(tx, receipt.id)) as unknown as Prisma.InputJsonValue;
      },
    );
    return result as unknown as ReturnReceiptDetail;
  }

  // --- lines ------------------------------------------------------------------------------------

  /**
   * The scan of a returned crate (doc 047 §4.5): a CRATE line, its delivered allocation
   * completed, the cycle RETURNED with its crate event. No bottle changes; the contents are never
   * assumed.
   */
  async scanCrate(
    principal: Principal,
    site: SiteContext,
    code: string,
    input: ReturnScanRequest,
  ): Promise<ReturnCrateScanResult> {
    const token = this.token(input.scannedValue);
    const receipt = await this.receiptInSite(code, site.siteId);
    const { result } = await this.operations.run(
      'RETURN_CRATE_SCAN',
      input.requestId,
      { actorId: principal.userId, siteId: site.siteId, receiptId: receipt.id, token },
      async (tx) => {
        if ((await this.lockReceipt(tx, receipt.id, 'UPDATE')) !== 'OPEN') throw receiptClosed();
        const kind = await this.registry.kindOf(token, tx);
        const crate = kind === 'CRATE' ? await this.cycles.crateByToken(tx, token) : null;
        if (!crate) throw domainError(422, 'NOT_A_CRATE', 'This is not a crate QR code');
        if (crate.siteId !== site.siteId) {
          throw domainError(409, 'CRATE_OF_ANOTHER_SITE', 'This crate belongs to another site');
        }
        await this.cycles.lockCrate(tx, crate.id);
        const cycle = await this.cycles.openCycle(tx, crate.id, true);
        if (cycle?.status === 'RETURNED') {
          const line = await tx.returnReceiptLine.findUniqueOrThrow({
            where: { returnedCycleId: cycle.id },
            select: {
              id: true,
              receiptId: true,
              receipt: { select: { code: true } },
              allocation: { select: { order: { select: { code: true } } } },
            },
          });
          if (line.receiptId === receipt.id) {
            return {
              outcome: 'ALREADY_SCANNED',
              lineId: line.id,
              crateCode: crate.code,
              orderCode: line.allocation!.order.code,
            };
          }
          throw domainErrorWithDetails(
            409,
            'CRATE_ALREADY_RETURNED',
            'This crate was already scanned in another return receipt',
            { crate: crate.code, receipt: line.receipt.code },
          );
        }
        const allocation =
          cycle?.status === 'DELIVERED'
            ? await this.orderReturns.deliveredAllocation(tx, cycle.id)
            : null;
        if (!cycle || !allocation) {
          throw domainErrorWithDetails(
            409,
            'CRATE_NOT_DELIVERED',
            'This crate has no delivered circulation to return',
            { crate: crate.code, status: cycle?.status ?? null },
          );
        }
        const now = new Date();
        const line = await tx.returnReceiptLine.create({
          data: {
            receiptId: receipt.id,
            kind: 'CRATE',
            crateId: crate.id,
            returnedCycleId: cycle.id,
            allocationId: allocation.id,
            scannedBy: principal.userId,
            scanOperationId: input.requestId,
          },
          select: { id: true },
        });
        await this.orderReturns.complete(tx, {
          allocationId: allocation.id,
          lineId: line.id,
          actorId: principal.userId,
          occurredAt: now,
        });
        await this.cycles.returnFromHotel(tx, cycle, {
          actorId: principal.userId,
          operationId: input.requestId,
          occurredAt: now,
          receipt: receipt.code,
          order: allocation.order.code,
        });
        return {
          outcome: 'CRATE_RETURNED',
          lineId: line.id,
          crateCode: crate.code,
          orderCode: allocation.order.code,
        };
      },
    );
    return result as ReturnCrateScanResult;
  }

  /** "Krabice bez kódu": a CONTAINER line. */
  async addContainer(
    principal: Principal,
    site: SiteContext,
    code: string,
    input: ReturnRequest,
  ): Promise<ReturnLineResult> {
    const receipt = await this.receiptInSite(code, site.siteId);
    const { result } = await this.operations.run(
      'RETURN_CONTAINER_ADD',
      input.requestId,
      { actorId: principal.userId, siteId: site.siteId, receiptId: receipt.id },
      async (tx) => {
        if ((await this.lockReceipt(tx, receipt.id, 'UPDATE')) !== 'OPEN') throw receiptClosed();
        const line = await tx.returnReceiptLine.create({
          data: {
            receiptId: receipt.id,
            kind: 'CONTAINER',
            scannedBy: principal.userId,
            scanOperationId: input.requestId,
          },
          select: { id: true },
        });
        return { lineId: line.id };
      },
    );
    return result as ReturnLineResult;
  }

  /**
   * Vyprázdněno / line done (doc 047 §4.5, §4.8): the physical count of THIS container compared
   * with what the line recorded (each piece once); a COUNT_MISMATCH issue if they differ; a CRATE
   * line's cycle → CLOSED.
   */
  async emptyLine(
    principal: Principal,
    site: SiteContext,
    code: string,
    lineId: string,
    input: EmptyReturnLineRequest,
  ): Promise<ReturnReceiptDetail> {
    const receipt = await this.receiptInSite(code, site.siteId);
    const line = await this.lineOf(receipt.id, lineId);
    const { result } = await this.operations.run(
      'RETURN_LINE_EMPTY',
      input.requestId,
      {
        actorId: principal.userId,
        siteId: site.siteId,
        receiptId: receipt.id,
        lineId: line.id,
        physicalCount: input.physicalCount,
      },
      async (tx) => {
        if ((await this.lockReceipt(tx, receipt.id, 'UPDATE')) !== 'OPEN') throw receiptClosed();
        const current = await tx.returnReceiptLine.findUniqueOrThrow({ where: { id: line.id } });
        if (current.emptiedAt) throw lineEmptied();
        if (current.kind === 'CRATE') {
          await this.cycles.lockCrate(tx, current.crateId!);
          await this.cycles.lockCycle(tx, current.returnedCycleId!);
        }
        const recorded = await this.recordedCount(tx, line.id);
        const now = new Date();
        if (recorded !== input.physicalCount) {
          await this.newIssue(tx, {
            receiptId: receipt.id,
            lineId: line.id,
            kind: 'COUNT_MISMATCH',
            bottleId: null,
            details: { physical: input.physicalCount, recorded },
            actorId: principal.userId,
            operationId: input.requestId,
          });
        }
        await tx.returnReceiptLine.update({
          where: { id: line.id },
          data: {
            emptiedAt: now,
            emptiedBy: principal.userId,
            emptyOperationId: input.requestId,
            physicalCount: input.physicalCount,
          },
        });
        if (current.kind === 'CRATE') {
          const cycle = await tx.crateCycle.findUniqueOrThrow({
            where: { id: current.returnedCycleId! },
            select: { id: true, crateId: true, siteId: true },
          });
          await this.cycles.closeEmptied(tx, cycle, {
            actorId: principal.userId,
            operationId: input.requestId,
            occurredAt: now,
            receipt: receipt.code,
          });
        }
        return (await this.detailOf(tx, receipt.id)) as unknown as Prisma.InputJsonValue;
      },
    );
    return result as unknown as ReturnReceiptDetail;
  }

  // --- pieces -----------------------------------------------------------------------------------

  /** "Nečitelná lahev +1": an UNREADABLE piece issue of the line. */
  async unreadable(
    principal: Principal,
    site: SiteContext,
    code: string,
    lineId: string,
    input: ReturnRequest,
  ): Promise<ReturnIssueResult> {
    const receipt = await this.receiptInSite(code, site.siteId);
    const line = await this.lineOf(receipt.id, lineId);
    const { result } = await this.operations.run(
      'RETURN_UNREADABLE',
      input.requestId,
      { actorId: principal.userId, siteId: site.siteId, receiptId: receipt.id, lineId: line.id },
      async (tx) => {
        if ((await this.lockReceipt(tx, receipt.id, 'SHARE')) !== 'OPEN') throw receiptClosed();
        await this.assertNotEmptied(tx, line.id);
        const issue = await this.newIssue(tx, {
          receiptId: receipt.id,
          lineId: line.id,
          kind: 'UNREADABLE',
          bottleId: null,
          details: {},
          actorId: principal.userId,
          operationId: input.requestId,
        });
        return { issue: { code: issue.code, kind: issue.kind } };
      },
    );
    return result as unknown as ReturnIssueResult;
  }

  /** "Vadná pumpička −1": defective pumps counted without identity; never a stock movement. */
  async countPumps(
    principal: Principal,
    site: SiteContext,
    code: string,
    input: ReturnPumpCountRequest,
  ): Promise<ReturnReceiptDetail> {
    const receipt = await this.receiptInSite(code, site.siteId);
    const { result } = await this.operations.run(
      'RETURN_PUMP_COUNT',
      input.requestId,
      {
        actorId: principal.userId,
        siteId: site.siteId,
        receiptId: receipt.id,
        defective: input.defective,
        reason: input.reason,
      },
      async (tx) => {
        if ((await this.lockReceipt(tx, receipt.id, 'SHARE')) !== 'OPEN') throw receiptClosed();
        await tx.returnPumpCount.create({
          data: {
            receiptId: receipt.id,
            defective: input.defective,
            reason: input.reason,
            recordedBy: principal.userId,
            operationId: input.requestId,
          },
        });
        return (await this.detailOf(tx, receipt.id)) as unknown as Prisma.InputJsonValue;
      },
    );
    return result as unknown as ReturnReceiptDetail;
  }

  /** The intake scan of one returned bottle on line L (doc 047 §4.5, §4.6). */
  async scanBottle(
    principal: Principal,
    site: SiteContext,
    code: string,
    lineId: string,
    input: ReturnBottleScanRequest,
  ): Promise<ReturnBottleScanResult> {
    const token = this.token(input.scannedValue);
    const receipt = await this.receiptInSite(code, site.siteId);
    const line = await this.lineOf(receipt.id, lineId);
    const outcome: Outcome = input.outcome === 'GOOD' ? 'RETURNED' : 'RETIRED';
    const { result } = await this.operations.run(
      'RETURN_BOTTLE_SCAN',
      input.requestId,
      {
        actorId: principal.userId,
        siteId: site.siteId,
        receiptId: receipt.id,
        lineId: line.id,
        token,
        outcome,
      },
      async (tx) => {
        const state = await this.lockReceipt(tx, receipt.id, 'SHARE');
        const bottle = await this.bottleOf(tx, token);
        const current = await tx.returnReceiptLine.findUniqueOrThrow({
          where: { id: line.id },
          select: { emptiedAt: true },
        });
        // The site boundary comes first (§4.6): nothing of another site is changed or named.
        if (bottle.siteId !== site.siteId) {
          if (state !== 'OPEN' || current.emptiedAt) {
            throw domainError(409, 'BOTTLE_OF_ANOTHER_SITE', 'This bottle belongs to another site');
          }
          return this.json(
            this.otherSitePiece(tx, receipt.id, line.id, token, principal, input.requestId),
          );
        }
        if (state !== 'OPEN') throw receiptClosed();
        if (current.emptiedAt) throw lineEmptied();
        return this.json(
          this.identifyOnLine(tx, {
            line: { id: line.id, scannedAt: line.scannedAt, receiptCode: receipt.code },
            bottle,
            outcome,
            actorId: principal.userId,
            operationId: input.requestId,
            resolving: null,
          }),
        );
      },
    );
    return result as unknown as ReturnBottleScanResult;
  }

  // --- issues -----------------------------------------------------------------------------------

  /**
   * Resolving a concrete piece issue by identification (doc 047 §4.8a): also on an emptied line
   * of a closed receipt, which stay as they are. The same path and lock order as a rescan.
   */
  async identifyIssue(
    principal: Principal,
    site: SiteContext,
    issueCode: string,
    input: IdentifyReturnIssueRequest,
  ): Promise<ReturnBottleScanResult> {
    const token = this.token(input.scannedValue);
    const issue = await this.issueInSite(issueCode, site.siteId);
    const outcome: Outcome = input.outcome === 'GOOD' ? 'RETURNED' : 'RETIRED';
    const { result } = await this.operations.run(
      'RETURN_ISSUE_RESOLVE',
      input.requestId,
      {
        actorId: principal.userId,
        siteId: site.siteId,
        receiptId: issue.receiptId,
        issueId: issue.id,
        resolution: 'IDENTIFIED',
        token,
        outcome,
      },
      async (tx) => {
        await this.lockReceipt(tx, issue.receiptId, 'SHARE');
        if (!IDENTIFIABLE.includes(issue.kind)) {
          throw domainError(409, 'ISSUE_NOT_IDENTIFIABLE', 'This issue is not resolved by a scan');
        }
        const bottle = await this.bottleOf(tx, token);
        if (bottle.siteId !== site.siteId) {
          throw domainError(409, 'BOTTLE_OF_ANOTHER_SITE', 'This bottle belongs to another site');
        }
        if (issue.bottleId && issue.bottleId !== bottle.id) {
          throw domainError(409, 'WRONG_BOTTLE', 'This issue names another bottle');
        }
        return this.json(
          this.identifyOnLine(tx, {
            line: {
              id: issue.lineId,
              scannedAt: issue.line.scannedAt,
              receiptCode: issue.receiptCode,
            },
            bottle,
            outcome,
            actorId: principal.userId,
            operationId: input.requestId,
            resolving: issue,
          }),
        );
      },
    );
    return result as unknown as ReturnBottleScanResult;
  }

  /** NOT_AYVO / WRITTEN_OFF, with a reason (returns:correct); writes no bottle event. */
  async closeOutIssue(
    principal: Principal,
    site: SiteContext,
    issueCode: string,
    input: CloseOutReturnIssueRequest,
  ): Promise<ReturnIssueSummary> {
    const issue = await this.issueInSite(issueCode, site.siteId);
    const { result } = await this.operations.run(
      'RETURN_ISSUE_RESOLVE',
      input.requestId,
      {
        actorId: principal.userId,
        siteId: site.siteId,
        receiptId: issue.receiptId,
        issueId: issue.id,
        resolution: input.resolution,
        reason: input.reason,
      },
      async (tx) => {
        await this.lockReceipt(tx, issue.receiptId, 'SHARE');
        const current = await this.lockIssue(tx, issue.id);
        if (current.resolvedAt) throw issueResolved();
        if (
          current.kind === 'COUNT_MISMATCH' ||
          (current.kind === 'OTHER_SITE' && input.resolution !== 'WRITTEN_OFF')
        ) {
          throw domainError(409, 'ISSUE_NOT_RESOLVABLE', 'This issue cannot be closed this way');
        }
        await tx.returnReceiptIssue.update({
          where: { id: issue.id },
          data: {
            resolvedAt: new Date(),
            resolvedBy: principal.userId,
            resolution: input.resolution,
            resolutionReason: input.reason,
            resolveOperationId: input.requestId,
          },
        });
        const row = await tx.returnReceiptIssue.findUniqueOrThrow({
          where: { id: issue.id },
          select: issueSelect,
        });
        return toIssue(row) as unknown as Prisma.InputJsonValue;
      },
    );
    return result as unknown as ReturnIssueSummary;
  }

  // --- the identification -----------------------------------------------------------------------

  /**
   * The checks of doc 047 §4.6 in their exact order, after the locks crate → cycle → bottle →
   * issue. `resolving` is the issue named by §4.8a (null for an intake scan, whose own open
   * issue of this bottle on L is then resolved by the same path).
   */
  private async identifyOnLine(
    tx: Tx,
    ctx: {
      line: LineAnchor;
      bottle: { id: string; code: string };
      outcome: Outcome;
      actorId: string;
      operationId: string;
      resolving: IssueRow | null;
    },
  ): Promise<ReturnBottleScanResult> {
    const { line, bottle, outcome } = ctx;
    // Locks: the open assignment read without a lock names crate X and cycle X, then crate →
    // cycle → bottle, then the assignment again (CONCURRENT_CHANGE if it moved).
    const seen = await tx.crateAssignment.findFirst({
      where: { bottleId: bottle.id, releasedAt: null },
      select: { id: true, cycleId: true, cycle: { select: { crateId: true } } },
    });
    if (seen) {
      await this.cycles.lockCrate(tx, seen.cycle.crateId);
      await this.cycles.lockCycle(tx, seen.cycleId);
    }
    const status = await this.bottles.lockForLabelApplication(tx, bottle.id);
    const assignment = await tx.crateAssignment.findFirst({
      where: { bottleId: bottle.id, releasedAt: null },
      select: {
        id: true,
        cycleId: true,
        assignedAt: true,
        cycle: { select: { status: true, crate: { select: { code: true } } } },
      },
    });
    // Released meanwhile (a concurrent identification committed first): no other crate needs a
    // lock, so the checks run on the new state and give the first result. A NEW assignment
    // elsewhere would need its crate locked after the bottle — refused instead (rescan).
    if (assignment && assignment.id !== seen?.id) throw concurrentChange();

    // The issue last: the named one, or this bottle's open piece issue on L (§4.6 lock order).
    let resolving: IssueRow | null = null;
    if (ctx.resolving) {
      const current = await this.lockIssue(tx, ctx.resolving.id);
      if (current.resolvedAt) {
        const first = current.resolvingEvent;
        if (
          first &&
          first.bottleId === bottle.id &&
          (first.payload as { outcome?: string }).outcome === outcome
        ) {
          return identified(bottle.code, outcome, true, current);
        }
        throw issueResolved();
      }
      resolving = ctx.resolving;
    } else {
      const own = await tx.returnReceiptIssue.findFirst({
        where: { bottleId: bottle.id, lineId: line.id, resolvedAt: null },
        select: { id: true },
      });
      if (own) {
        const current = await this.lockIssue(tx, own.id);
        if (!current.resolvedAt) resolving = current;
      }
    }

    // 2. Already identified on this line.
    const lastSorted = await tx.bottleEvent.findFirst({
      where: { bottleId: bottle.id, type: 'SORTED' },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        recordedAt: true,
        returnLineId: true,
        payload: true,
        returnLine: { select: { receipt: { select: { code: true } } } },
      },
    });
    const here = await tx.bottleEvent.findFirst({
      where: { bottleId: bottle.id, type: 'SORTED', returnLineId: line.id },
      orderBy: { id: 'desc' },
      select: { id: true, payload: true, resolvesIssue: { select: { code: true, kind: true } } },
    });
    if (here) {
      const notMovedOn =
        lastSorted?.id === here.id &&
        !assignment &&
        (status === 'RETURNED' || status === 'RETIRED');
      if (notMovedOn && (here.payload as { outcome?: string }).outcome === outcome) {
        return identified(bottle.code, outcome, true, here.resolvesIssue);
      }
      throw domainErrorWithDetails(
        409,
        'ALREADY_RECEIVED',
        'This bottle was already received on this line; a change is a correction',
        { receipt: line.receiptCode },
      );
    }
    // 3. Identified elsewhere, and not in circulation again before L.
    if (lastSorted) {
      const inCirculationAgain =
        !!assignment &&
        assignment.assignedAt > lastSorted.recordedAt &&
        assignment.assignedAt < line.scannedAt;
      if (!inCirculationAgain) {
        throw domainErrorWithDetails(
          409,
          'ALREADY_RECEIVED_ELSEWHERE',
          'This bottle was already received on another line',
          { receipt: lastSorted.returnLine?.receipt.code ?? null },
        );
      }
    }
    // 4. An open piece issue of this bottle on another line.
    const elsewhere = await tx.returnReceiptIssue.findFirst({
      where: {
        bottleId: bottle.id,
        resolvedAt: null,
        lineId: { not: line.id },
        ...(resolving ? { id: { not: resolving.id } } : {}),
      },
      select: { code: true },
    });
    if (elsewhere) {
      throw domainErrorWithDetails(
        409,
        'OPEN_ISSUE',
        'This bottle has an open issue: resolve that issue',
        { issue: elsewhere.code },
      );
    }
    const before = !!assignment && assignment.assignedAt < line.scannedAt;
    // 5. The delivered cycle → the identification.
    if (assignment && before && SHIPPED.includes(assignment.cycle.status) && status === 'FILLED') {
      if (await this.orderReturns.shippedIn(tx, assignment.id)) {
        const now = new Date();
        const sortedId = await this.bottles.identifyAtReturn(tx, {
          bottleId: bottle.id,
          crateCycleId: assignment.cycleId,
          returnLineId: line.id,
          resolvesIssueId: resolving?.id ?? null,
          outcome,
          actorId: ctx.actorId,
          operationRequestId: ctx.operationId,
          occurredAt: now,
          receipt: line.receiptCode,
          crateCode: assignment.cycle.crate.code,
        });
        await this.cycles.releaseByReturn(tx, {
          assignmentId: assignment.id,
          sortedEventId: sortedId,
          actorId: ctx.actorId,
          operationId: ctx.operationId,
          occurredAt: now,
        });
        if (resolving) {
          await tx.returnReceiptIssue.update({
            where: { id: resolving.id },
            data: {
              resolvedAt: now,
              resolvedBy: ctx.actorId,
              resolution: 'IDENTIFIED',
              resolveOperationId: ctx.operationId,
              resolvingEventId: sortedId,
            },
          });
        }
        return identified(bottle.code, outcome, false, resolving);
      }
    }
    // 6. Not delivered yet.
    if (
      assignment &&
      before &&
      (assignment.cycle.status === 'ALLOCATED' || assignment.cycle.status === 'DISPATCHED')
    ) {
      return this.pieceIssue(tx, ctx, resolving, 'NOT_DELIVERED');
    }
    // 7. Assigned after L was opened: it cannot be in this container.
    if (assignment && !before) {
      throw domainError(409, 'NOT_IN_THIS_LINE', 'This bottle cannot be in this container');
    }
    // 8. Not in circulation.
    return this.pieceIssue(tx, ctx, resolving, 'NOT_IN_CIRCULATION');
  }

  /**
   * A refusal that records an issue (checks 6 and 8): committed with its result. A resolution
   * (§4.8a) records nothing and keeps the issue open; a rescan with its open issue on L returns
   * that issue — never a second piece.
   */
  private async pieceIssue(
    tx: Tx,
    ctx: {
      line: LineAnchor;
      bottle: { id: string; code: string };
      actorId: string;
      operationId: string;
      resolving: IssueRow | null;
    },
    own: IssueRow | null,
    kind: 'NOT_DELIVERED' | 'NOT_IN_CIRCULATION',
  ): Promise<ReturnBottleScanResult> {
    if (ctx.resolving) {
      throw domainError(
        409,
        kind,
        kind === 'NOT_DELIVERED'
          ? 'This bottle is not delivered yet: the issue stays open'
          : 'This bottle is not in circulation: the issue stays open',
      );
    }
    const issue =
      own ??
      (await this.newIssue(tx, {
        receiptId: (await tx.returnReceiptLine.findUniqueOrThrow({
          where: { id: ctx.line.id },
          select: { receiptId: true },
        }))!.receiptId,
        lineId: ctx.line.id,
        kind,
        bottleId: ctx.bottle.id,
        details: {},
        actorId: ctx.actorId,
        operationId: ctx.operationId,
      }));
    return {
      outcome: 'ISSUE_RECORDED',
      repeated: false,
      code: kind,
      bottleCode: ctx.bottle.code,
      result: null,
      issue: { code: issue.code, kind: issue.kind },
    };
  }

  /** OTHER_SITE: a piece of this line without any link to the other site's bottle. */
  private async otherSitePiece(
    tx: Tx,
    receiptId: string,
    lineId: string,
    token: string,
    principal: Principal,
    operationId: string,
  ): Promise<ReturnBottleScanResult> {
    // The same foreign piece scanned again on this line is the same piece (a one-way digest,
    // never shown, so nothing of the other site is exposed).
    const piece = createHash('sha256').update(token).digest('hex');
    // Concurrent scans of the same piece on the same line hold only the shared receipt lock:
    // serialise them on (line, piece), then the second sees the first's issue (unique in the DB).
    const key = `${lineId}:${piece}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
    const existing = await tx.returnReceiptIssue.findFirst({
      where: { lineId, kind: 'OTHER_SITE', details: { path: ['piece'], equals: piece } },
      select: { code: true, kind: true },
    });
    const issue =
      existing ??
      (await this.newIssue(tx, {
        receiptId,
        lineId,
        kind: 'OTHER_SITE',
        bottleId: null,
        details: { piece },
        actorId: principal.userId,
        operationId,
      }));
    return {
      outcome: 'ISSUE_RECORDED',
      repeated: !!existing,
      code: 'BOTTLE_OF_ANOTHER_SITE',
      bottleCode: null,
      result: null,
      issue: { code: issue.code, kind: issue.kind },
    };
  }

  // --- helpers ----------------------------------------------------------------------------------

  /** A result stored by OperationRequestsService (plain JSON). */
  private async json<T>(value: Promise<T>): Promise<Prisma.InputJsonValue> {
    return (await value) as unknown as Prisma.InputJsonValue;
  }

  private token(scannedValue: string): string {
    const scan = classifyScannedQr(scannedValue, this.env.PUBLIC_QR_BASE_URL);
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

  private async bottleOf(tx: Tx, token: string) {
    const kind = await this.registry.kindOf(token, tx);
    if (kind && kind !== 'BOTTLE') {
      throw domainError(422, 'NOT_A_BOTTLE', 'This is not a bottle QR code');
    }
    const bottle = await this.bottles.findByPublicToken(tx, token);
    if (!bottle) throw domainError(422, 'UNKNOWN_LABEL', 'No bottle has this label');
    return bottle;
  }

  /** The receipt of the active site (another site's receipt does not exist for the caller). */
  private async receiptInSite(code: string, siteId: string) {
    const serial = parseCodeSerial(CODE_PREFIX.returnReceipt, code);
    const receipt =
      serial === null
        ? null
        : await this.prisma.returnReceipt.findUnique({
            where: { serial },
            select: { id: true, code: true, siteId: true },
          });
    if (!receipt || receipt.siteId !== siteId) throw notFound();
    return receipt;
  }

  private async lineOf(receiptId: string, lineId: string) {
    const line = /^[0-9a-f-]{36}$/i.test(lineId)
      ? await this.prisma.returnReceiptLine.findUnique({
          where: { id: lineId },
          select: { id: true, receiptId: true, scannedAt: true },
        })
      : null;
    if (!line || line.receiptId !== receiptId) {
      throw domainError(404, 'RETURN_LINE_NOT_FOUND', 'No such line in this receipt');
    }
    return line;
  }

  private async issueInSite(code: string, siteId: string) {
    const serial = parseCodeSerial(CODE_PREFIX.returnIssue, code);
    const issue =
      serial === null
        ? null
        : await this.prisma.returnReceiptIssue.findUnique({
            where: { serial },
            select: {
              id: true,
              code: true,
              kind: true,
              bottleId: true,
              lineId: true,
              receiptId: true,
              receipt: { select: { code: true, siteId: true } },
              line: { select: { scannedAt: true } },
            },
          });
    if (!issue || issue.receipt.siteId !== siteId) throw issueNotFound();
    return { ...issue, receiptCode: issue.receipt.code };
  }

  private async lockReceipt(tx: Tx, id: string, mode: 'SHARE' | 'UPDATE') {
    const rows =
      mode === 'SHARE'
        ? await tx.$queryRaw<{ state: string }[]>`
            SELECT "state"::text FROM "return_receipts" WHERE "id" = ${id}::uuid FOR SHARE`
        : await tx.$queryRaw<{ state: string }[]>`
            SELECT "state"::text FROM "return_receipts" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows[0]!.state as 'OPEN' | 'CLOSED';
  }

  private async lockIssue(tx: Tx, id: string) {
    await tx.$executeRaw`SELECT 1 FROM "return_receipt_issues" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.returnReceiptIssue.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        code: true,
        kind: true,
        bottleId: true,
        lineId: true,
        resolvedAt: true,
        resolution: true,
        resolvingEvent: { select: { bottleId: true, payload: true } },
      },
    });
  }

  private async assertNotEmptied(tx: Tx, lineId: string) {
    const line = await tx.returnReceiptLine.findUniqueOrThrow({
      where: { id: lineId },
      select: { emptiedAt: true },
    });
    if (line.emptiedAt) throw lineEmptied();
  }

  private async newIssue(
    tx: Tx,
    input: {
      receiptId: string;
      lineId: string;
      kind: ReturnIssueKind;
      bottleId: string | null;
      details: Record<string, unknown>;
      actorId: string;
      operationId: string;
    },
  ) {
    const { first: serial } = await allocateSerials(tx, 'return_issue', 1);
    return tx.returnReceiptIssue.create({
      data: {
        serial,
        code: formatCode(CODE_PREFIX.returnIssue, serial),
        receiptId: input.receiptId,
        lineId: input.lineId,
        kind: input.kind,
        bottleId: input.bottleId,
        details: input.details as Prisma.InputJsonValue,
        recordedBy: input.actorId,
        recordOperationId: input.operationId,
      },
      select: { id: true, code: true, kind: true, bottleId: true, lineId: true },
    });
  }

  /** Each piece once: its piece issue (resolved or not), or its own SORTED (§4.8). */
  private async recordedCount(db: Tx, lineId: string): Promise<number> {
    const [issues, sorted] = await Promise.all([
      db.returnReceiptIssue.count({ where: { lineId, kind: { in: PIECE_KINDS } } }),
      db.bottleEvent.count({
        where: { returnLineId: lineId, type: 'SORTED', resolvesIssueId: null },
      }),
    ]);
    return issues + sorted;
  }

  private async summary(db: Tx, id: string): Promise<ReturnReceiptSummary> {
    const r = await db.returnReceipt.findUniqueOrThrow({
      where: { id },
      select: {
        code: true,
        state: true,
        openedAt: true,
        closedAt: true,
        hotel: { select: { name: true } },
        _count: { select: { lines: true } },
      },
    });
    const [identified, openIssues] = await Promise.all([
      db.bottleEvent.count({ where: { type: 'SORTED', returnLine: { receiptId: id } } }),
      db.returnReceiptIssue.count({
        where: { receiptId: id, resolvedAt: null, kind: { not: 'COUNT_MISMATCH' } },
      }),
    ]);
    return {
      code: r.code,
      state: r.state,
      hotelName: r.hotel?.name ?? null,
      openedAt: r.openedAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
      lines: r._count.lines,
      identified,
      openIssues,
    };
  }

  private async detailOf(db: Tx, id: string): Promise<ReturnReceiptDetail> {
    const summary = await this.summary(db, id);
    const r = await db.returnReceipt.findUniqueOrThrow({
      where: { id },
      select: {
        hotel: { select: { code: true } },
        pumpCounts: { select: { defective: true } },
        lines: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            kind: true,
            returnedCycleId: true,
            scannedAt: true,
            emptiedAt: true,
            physicalCount: true,
            crate: { select: { code: true } },
            allocation: {
              select: { order: { select: { code: true, hotel: { select: { name: true } } } } },
            },
            sortedEvents: {
              where: { type: 'SORTED' },
              orderBy: { id: 'asc' },
              select: {
                occurredAt: true,
                payload: true,
                bottle: { select: { code: true } },
                crateCycleId: true,
                resolvesIssue: { select: { code: true } },
              },
            },
            issues: { orderBy: { serial: 'asc' }, select: issueSelect },
          },
        },
      },
    });
    const lineDetails: ReturnLineDetail[] = [];
    const shippedOf = new Map<string, Awaited<ReturnType<OrderReturnsService['shippedOfCycle']>>>();
    const cycleShipped = async (cycleId: string) => {
      if (!shippedOf.has(cycleId)) {
        shippedOf.set(cycleId, await this.orderReturns.shippedOfCycle(db, cycleId));
      }
      return shippedOf.get(cycleId)!;
    };
    for (const l of r.lines) {
      const bottles = [];
      for (const e of l.sortedEvents) {
        const shipped = await cycleShipped(e.crateCycleId!);
        const payload = e.payload as { outcome: 'RETURNED' | 'RETIRED'; crate: string };
        bottles.push({
          bottleCode: e.bottle.code,
          outcome: payload.outcome,
          crateCode: payload.crate,
          orderCode: shipped?.orderCode ?? '',
          at: e.occurredAt.toISOString(),
          resolvesIssue: e.resolvesIssue?.code ?? null,
        });
      }
      let history: ReturnLineDetail['history'] = null;
      if (l.returnedCycleId) {
        const shipped = await cycleShipped(l.returnedCycleId);
        const identified = await db.bottleEvent.count({
          where: { type: 'SORTED', crateCycleId: l.returnedCycleId },
        });
        const n = shipped?.shipped ?? 0;
        history = { shipped: n, identified, withoutConfirmedReturn: n - identified };
      }
      lineDetails.push({
        id: l.id,
        kind: l.kind,
        crateCode: l.crate?.code ?? null,
        orderCode: l.allocation?.order.code ?? null,
        hotelName: l.allocation?.order.hotel.name ?? null,
        scannedAt: l.scannedAt.toISOString(),
        emptiedAt: l.emptiedAt?.toISOString() ?? null,
        physicalCount: l.physicalCount,
        recordedCount: await this.recordedCount(db, l.id),
        bottles,
        issues: l.issues.map(toIssue),
        history,
      });
    }
    return {
      ...summary,
      hotelCode: r.hotel?.code ?? null,
      defectivePumps: r.pumpCounts.reduce((sum, p) => sum + p.defective, 0),
      lineDetails,
    };
  }
}

const issueSelect = {
  code: true,
  kind: true,
  lineId: true,
  details: true,
  recordedAt: true,
  resolution: true,
  resolvedAt: true,
  resolutionReason: true,
  receipt: { select: { code: true } },
  bottle: { select: { code: true } },
} satisfies Prisma.ReturnReceiptIssueSelect;

function toIssue(
  row: Prisma.ReturnReceiptIssueGetPayload<{ select: typeof issueSelect }>,
): ReturnIssueSummary {
  // The OTHER_SITE digest is internal: never shown.
  const details = { ...((row.details ?? {}) as Record<string, unknown>) };
  delete details.piece;
  return {
    code: row.code,
    kind: row.kind,
    receipt: row.receipt.code,
    lineId: row.lineId,
    bottleCode: row.bottle?.code ?? null,
    details,
    recordedAt: row.recordedAt.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionReason: row.resolutionReason,
  };
}

function identified(
  bottleCode: string,
  outcome: Outcome,
  repeated: boolean,
  issue: { code: string; kind: ReturnIssueKind } | null,
): ReturnBottleScanResult {
  return {
    outcome: 'IDENTIFIED',
    repeated,
    code: null,
    bottleCode,
    result: outcome,
    issue: issue ? { code: issue.code, kind: issue.kind } : null,
  };
}
