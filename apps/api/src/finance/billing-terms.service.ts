import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BillingAgreementDetail,
  BillingAgreementTerms,
  BillingRestoreRequest,
  BillingRestoreResult,
  NewBillingAgreementVersionRequest,
} from '@ayvo/types';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import {
  BillingSettingsService,
  concurrentChange,
  customerNotFound,
  effectiveAt,
  versionData,
} from './billing-settings.service.js';
import { CoreClient } from './core-client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';
import { nextTermsRevision, pendingTransferRow, termsChangePending } from './billing-terms.js';
import { derivedRequestId } from './portal-grants.service.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | FinancePrismaService;

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** Today in Prague as a date column value (terms are valid per calendar day). */
const pragueToday = () =>
  date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date()));

/** The terms' lock: every terms change and issuing (shared) serialize on it (BILL86-R1). */
const lockTerms = (tx: Tx) =>
  tx.$executeRaw`SELECT 1 FROM "finance"."code_counters" WHERE "name" = 'billing_revision' FOR UPDATE`;

/** The core's request id of a transfer's fence: derived, so every attempt names the same fence. */
const fenceRequestId = (r: { requestId: string }) => derivedRequestId(r.requestId, 'portal-fence');

/**
 * Who leaves the hotel with new terms (v6): on the day D they start to matter — their first day,
 * or today when that is past — the payer then (as recorded so far) loses it when the terms in
 * effect at D name another payer (last day D − 1), or end it earlier than before (last day the
 * new `validTo`). Null: the payer stays as it was (a CHANGE).
 */
export function leavingPayer(
  versions: readonly {
    effectiveFrom: Date;
    recordedAt: Date;
    revision: bigint;
    customerId: string;
    validTo: Date | null;
  }[],
  terms: BillingAgreementTerms,
  today: Date,
  now: Date,
): { payerCustomerId: string; endsOn: Date } | null {
  const from = date(`${terms.effectiveFrom}-01`);
  const at = from > today ? from : today;
  const prior = effectiveAt(versions, at, now);
  if (!prior) return null;
  const proposed = {
    effectiveFrom: from,
    recordedAt: now,
    revision: BigInt(Number.MAX_SAFE_INTEGER),
    customerId: terms.customerId,
    validTo: terms.validTo === null ? null : date(terms.validTo),
  };
  const after = effectiveAt([...versions, proposed], at, now)!;
  if (after.customerId !== prior.customerId)
    return { payerCustomerId: prior.customerId, endsOn: new Date(at.getTime() - DAY) };
  if (
    after === proposed &&
    proposed.validTo !== null &&
    (prior.validTo === null || proposed.validTo < prior.validTo)
  )
    return { payerCustomerId: prior.customerId, endsOn: proposed.validTo };
  return null;
}

const UNAVAILABLE = 'FINANCE_DEPENDENCY_UNAVAILABLE';
/** A refusal the core gave after evaluating the request: nothing was written under it. */
const isCoreRefusal = (e: unknown) =>
  e instanceof HttpException &&
  [400, 404, 409].includes(e.getStatus()) &&
  (e.getResponse() as { code?: string }).code !== UNAVAILABLE;

/**
 * Terms revisions of hotel billing agreements (v6, #148; review 5858166766): the normal path of a
 * change of payer guards the hotel portal before it exists.
 *
 * A change: one revision, committed with its version at once (CHANGE). A change that takes the
 * hotel from its payer (TRANSFER): (1) reserved with its revision, nothing else of the agreement
 * may change meanwhile; (2) the core's fence for the leaving payer — no Finance transaction is
 * held during the call; (3) committed with its version, or abandoned. A lost answer or an outage
 * between them leaves the reservation: the same request, or "Dokončit", finishes it with the same
 * fence; "Zrušit" settles the fence request at the core first, so Finance knows every fence there
 * is. An explicit restore (RESTORE) is committed in Finance and only then sent to the core, built
 * from that stored revision alone.
 */
@Injectable()
export class BillingTermsService {
  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    private readonly core: CoreClient,
    private readonly billing: BillingSettingsService,
  ) {}

  async newAgreementVersion(
    code: string,
    req: NewBillingAgreementVersionRequest,
    caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    const { userId, displayName } = caller.principal;
    const { result } = await this.operations.run(
      'BILLING_AGREEMENT_VERSION',
      req.requestId,
      { code, expectedRevision: req.expectedRevision, terms: req.terms, actorId: userId },
      async (tx) => {
        await lockTerms(tx);
        const a = await tx.billingAgreement.findUnique({
          where: { code },
          include: { versions: true },
        });
        if (!a) throw new NotFoundException('Smlouva nenalezena');
        const newest = a.versions.reduce((b, v) => (v.revision > b.revision ? v : b));
        // The whole terms form edited from an older revision: refused, never written back.
        if (Number(newest.revision) !== req.expectedRevision) throw concurrentChange();
        if (await pendingTransferRow(tx, a.id)) throw termsChangePending();
        // Checked now: a reserved transfer's terms are written only after the fence.
        if (!(await tx.customer.findUnique({ where: { id: req.terms.customerId } })))
          throw customerNotFound();
        const termsRevision = await nextTermsRevision(tx, a.id);
        const leaving = leavingPayer(a.versions, req.terms, pragueToday(), new Date());
        const recorded = { recordedBy: userId, recordedByName: displayName };
        try {
          if (leaving) {
            const r = await tx.billingTermsRevision.create({
              data: {
                agreementId: a.id,
                revision: termsRevision,
                intent: 'TRANSFER',
                requestId: req.requestId,
                payerCustomerId: leaving.payerCustomerId,
                baseRevision: newest.revision,
                terms: req.terms,
                fenceEndsOn: leaving.endsOn,
                reason: req.terms.reason,
                ...recorded,
              },
            });
            return { code, transferId: r.id };
          }
          const r = await tx.billingTermsRevision.create({
            data: {
              agreementId: a.id,
              revision: termsRevision,
              intent: 'CHANGE',
              requestId: req.requestId,
              payerCustomerId: req.terms.customerId,
              baseRevision: newest.revision,
              reason: req.terms.reason,
              ...recorded,
            },
          });
          const revision = await allocateFinanceSerial(tx, 'billing_revision');
          const v = await tx.agreementVersion.create({
            data: versionData(
              a.id,
              revision,
              termsRevision,
              req.terms,
              userId,
              displayName,
              req.requestId,
            ),
          });
          await tx.billingTermsRevisionEvent.create({
            data: { revisionId: r.id, kind: 'COMMITTED', agreementVersionId: v.id, ...recorded },
          });
          return { code, transferId: null };
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003')
            throw customerNotFound();
          throw e;
        }
      },
    );
    if (result.transferId) await this.complete(caller, result.transferId);
    return this.billing.agreementDetail(code);
  }

  /** "Dokončit": the agreement's reserved transfer, finished with the terms it was reserved with. */
  async finishTransfer(
    code: string,
    termsRevision: number,
    caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    const r = await this.transferOf(code, termsRevision);
    await this.complete(caller, r.id);
    return this.billing.agreementDetail(code);
  }

  /**
   * "Zrušit": the reserved transfer is abandoned and its terms never written. The core first
   * settles its fence request (the fence written under it, or none ever), so a fence Finance never
   * got an answer for is still recorded here and can be named by a restore. Repeatable.
   */
  async abandonTransfer(
    code: string,
    termsRevision: number,
    caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    const r = await this.transferOf(code, termsRevision);
    const state = await this.state(this.prisma, r.id);
    if (state.committed)
      throw domainError(409, 'TRANSFER_COMMITTED', 'Změna už je zapsaná; zrušit ji nelze.');
    if (!state.abandoned) {
      const fenceId =
        state.fenceId ??
        (await this.core.settlePortalFence(caller.sessionToken, fenceRequestId(r))).fence?.id ??
        null;
      await this.settle(caller, r.id, fenceId, null);
    }
    return this.billing.agreementDetail(code);
  }

  /**
   * An explicit restore of the payer's operations on the agreement's hotel (v6 §1): committed here
   * first — the payer's terms in effect today, each named fence of this agreement's transfers of
   * that payer, none named by another restore — then sent. The answer says whether the core
   * accepted it; a committed restore not sent yet is sent again by `sendRestore` (the same
   * evidence, the same request id).
   */
  async restore(
    code: string,
    req: BillingRestoreRequest,
    caller: FinanceCaller,
  ): Promise<BillingRestoreResult> {
    const { userId, displayName } = caller.principal;
    const fenceIds = [...req.fenceIds].sort();
    const { result } = await this.operations.run(
      'BILLING_TERMS_RESTORE',
      req.requestId,
      { code, payerCustomerId: req.payerCustomerId, fenceIds, reason: req.reason, actorId: userId },
      async (tx) => {
        await lockTerms(tx);
        const a = await tx.billingAgreement.findUnique({
          where: { code },
          include: { versions: true },
        });
        if (!a) throw new NotFoundException('Smlouva nenalezena');
        if (await pendingTransferRow(tx, a.id)) throw termsChangePending();
        const today = pragueToday();
        const v = effectiveAt(a.versions, today, new Date());
        if (
          !v ||
          v.customerId !== req.payerCustomerId ||
          v.validFrom > today ||
          (v.validTo !== null && v.validTo < today)
        )
          throw domainError(
            409,
            'RESTORE_NOT_PAYER',
            'Obnovit provoz lze jen plátci, jehož podmínky dnes platí.',
          );
        const fenced = await tx.billingTermsRevisionEvent.findMany({
          where: {
            kind: 'FENCED',
            fenceId: { in: fenceIds },
            revision: {
              agreementId: a.id,
              intent: 'TRANSFER',
              payerCustomerId: req.payerCustomerId,
            },
          },
          select: { fenceId: true },
        });
        const known = new Set(fenced.map((e) => e.fenceId));
        const foreign = fenceIds.filter((id) => !known.has(id));
        if (foreign.length > 0)
          throw domainErrorWithDetails(
            409,
            'FENCE_NOT_OF_PAYER',
            'Pojistka nepatří převodu tohoto plátce u této smlouvy.',
            { fenceIds: foreign },
          );
        const restored = await tx.billingTermsRevision.findFirst({
          where: { agreementId: a.id, intent: 'RESTORE', resolvesFenceIds: { hasSome: fenceIds } },
          select: { revision: true },
        });
        if (restored)
          throw domainErrorWithDetails(
            409,
            'FENCE_ALREADY_RESTORED',
            'Pojistku už obnovila jiná obnova.',
            { termsRevision: restored.revision },
          );
        const termsRevision = await nextTermsRevision(tx, a.id);
        const r = await tx.billingTermsRevision.create({
          data: {
            agreementId: a.id,
            revision: termsRevision,
            intent: 'RESTORE',
            requestId: req.requestId,
            payerCustomerId: req.payerCustomerId,
            resolvesFenceIds: fenceIds,
            reason: req.reason,
            recordedBy: userId,
            recordedByName: displayName,
          },
        });
        await tx.billingTermsRevisionEvent.create({
          data: {
            revisionId: r.id,
            kind: 'COMMITTED',
            recordedBy: userId,
            recordedByName: displayName,
          },
        });
        return { termsRevision };
      },
    );
    let sent = false;
    try {
      sent = await this.send(caller, code, result.termsRevision);
    } catch (e) {
      // Committed here; the core did not answer — the payer page offers to send it again.
      if ((e as { getResponse?: () => { code?: string } }).getResponse?.().code !== UNAVAILABLE)
        throw e;
    }
    return { termsRevision: result.termsRevision, fenceIds, sent };
  }

  /** A committed restore sent (again) to the core. Any other revision: 409, nothing is sent. */
  async sendRestore(
    code: string,
    termsRevision: number,
    caller: FinanceCaller,
  ): Promise<BillingRestoreResult> {
    await this.send(caller, code, termsRevision);
    const r = await this.prisma.billingTermsRevision.findFirstOrThrow({
      where: { agreement: { code }, revision: termsRevision },
    });
    return { termsRevision, fenceIds: r.resolvesFenceIds, sent: true };
  }

  // --- steps --------------------------------------------------------------------------------

  /**
   * The resolution's evidence, built ONLY from a stored RESTORE revision in state COMMITTED (v6
   * §1): never from the agreement's current terms, never from a revision of another intent.
   */
  private async send(caller: FinanceCaller, code: string, termsRevision: number) {
    const r = await this.prisma.billingTermsRevision.findFirst({
      where: { agreement: { code }, revision: termsRevision },
      include: { agreement: true, events: true },
    });
    if (!r) throw new NotFoundException('Revize nenalezena');
    if (r.intent !== 'RESTORE' || !r.events.some((e) => e.kind === 'COMMITTED'))
      throw domainError(409, 'NOT_A_RESTORE', 'Tato revize není potvrzená obnova provozu.');
    await this.core.portalFenceResolution(caller.sessionToken, {
      kind: 'RESTORE',
      restoreRequestId: r.requestId,
      payerCustomerId: r.payerCustomerId,
      hotelId: r.agreement.hotelId,
      restoreRevision: r.revision,
      fenceIds: r.resolvesFenceIds,
    });
    if (!r.events.some((e) => e.kind === 'RESOLVED_SENT'))
      await this.prisma.billingTermsRevisionEvent
        .create({
          data: {
            revisionId: r.id,
            kind: 'RESOLVED_SENT',
            recordedBy: caller.principal.userId,
            recordedByName: caller.principal.displayName,
          },
        })
        .catch((e: unknown) => {
          // Sent twice at once: the other one recorded it.
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        });
    return true;
  }

  /** The fence (same request id each attempt), then the commit — or the core's refusal settles it. */
  private async complete(caller: FinanceCaller, revisionId: string): Promise<void> {
    const r = await this.prisma.billingTermsRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: { agreement: true },
    });
    const state = await this.state(this.prisma, r.id);
    if (state.committed) return;
    if (state.abandoned) throw transferAbandoned();
    let fenceId = state.fenceId;
    if (!fenceId) {
      try {
        const fence = await this.core.portalFence(caller.sessionToken, {
          requestId: fenceRequestId(r),
          payerCustomerId: r.payerCustomerId,
          hotelId: r.agreement.hotelId,
          endsOn: day(r.fenceEndsOn!),
          termsRevision: r.revision,
          reason: r.reason,
        });
        fenceId = fence.id;
      } catch (e) {
        // The core evaluated and refused it (nothing written): the change cannot go on.
        if (isCoreRefusal(e)) await this.settle(caller, r.id, null, null);
        // Otherwise (unreachable, no answer) the reservation stays: finish or abandon it later.
        throw e;
      }
    }
    await this.settle(caller, r.id, fenceId, r);
  }

  /**
   * Under the terms' lock: FENCED (when known) and then COMMITTED with the version (`commit`
   * given and the agreement unchanged since the reservation) — else ABANDONED. Once settled,
   * nothing more is written.
   */
  private async settle(
    caller: FinanceCaller,
    revisionId: string,
    fenceId: string | null,
    commit: Prisma.BillingTermsRevisionGetPayload<object> | null,
  ): Promise<void> {
    const recorded = {
      recordedBy: caller.principal.userId,
      recordedByName: caller.principal.displayName,
    };
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await lockTerms(tx);
        const state = await this.state(tx, revisionId);
        if (state.committed) return 'COMMITTED' as const;
        if (state.abandoned) return 'ABANDONED' as const;
        if (fenceId && !state.fenceId)
          await tx.billingTermsRevisionEvent.create({
            data: { revisionId, kind: 'FENCED', fenceId, ...recorded },
          });
        if (commit) {
          const newest = await tx.agreementVersion.findFirst({
            where: { agreementId: commit.agreementId },
            orderBy: { revision: 'desc' },
            select: { revision: true },
          });
          if (newest?.revision === commit.baseRevision) {
            const terms = commit.terms as unknown as BillingAgreementTerms;
            const revision = await allocateFinanceSerial(tx, 'billing_revision');
            const v = await tx.agreementVersion.create({
              data: versionData(
                commit.agreementId,
                revision,
                commit.revision,
                terms,
                commit.recordedBy,
                commit.recordedByName,
                commit.requestId,
              ),
            });
            await tx.billingTermsRevisionEvent.create({
              data: { revisionId, kind: 'COMMITTED', agreementVersionId: v.id, ...recorded },
            });
            return 'COMMITTED' as const;
          }
        }
        await tx.billingTermsRevisionEvent.create({
          data: { revisionId, kind: 'ABANDONED', ...recorded },
        });
        return commit ? ('STALE' as const) : ('ABANDONED' as const);
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
    if (outcome === 'STALE') throw concurrentChange();
    if (outcome === 'ABANDONED' && commit) throw transferAbandoned();
  }

  private async state(db: Db, revisionId: string) {
    const events = await db.billingTermsRevisionEvent.findMany({ where: { revisionId } });
    return {
      committed: events.some((e) => e.kind === 'COMMITTED'),
      abandoned: events.some((e) => e.kind === 'ABANDONED'),
      fenceId: events.find((e) => e.kind === 'FENCED')?.fenceId ?? null,
    };
  }

  private async transferOf(code: string, termsRevision: number) {
    const r = await this.prisma.billingTermsRevision.findFirst({
      where: { agreement: { code }, revision: termsRevision, intent: 'TRANSFER' },
    });
    if (!r) throw new NotFoundException('Rozpracovaná změna nenalezena');
    return r;
  }
}

const transferAbandoned = () =>
  domainError(409, 'TRANSFER_ABANDONED', 'Tato změna plátce byla zrušena; zapište ji znovu.');
