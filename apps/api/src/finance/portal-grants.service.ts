import { createHash } from 'node:crypto';
import type {
  FinancePortalAccess,
  FinancePortalGrantIssue,
  FinancePortalGrantReplace,
  FinancePortalGrantResult,
  FinancePortalPayerHotel,
} from '@ayvo/types';
import { Injectable, Logger } from '@nestjs/common';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { effectiveAt } from './billing-settings.service.js';
import { CoreClient } from './core-client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FinancePrismaService } from './finance-prisma.service.js';

/** Today in Prague as a date column value (agreements are valid per calendar day). */
const pragueToday = () =>
  new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date())}T00:00:00.000Z`,
  );

/**
 * A stable request id of a follow-up step, derived from the request's own id: a retry of the same
 * request repeats the same step, never a new one (UUID v5 layout over SHA-256).
 */
export function derivedRequestId(requestId: string, step: string): string {
  const h = createHash('sha256').update(`${requestId}:${step}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

type Invitation = FinancePortalGrantResult['invitation'];

/**
 * Hotel portal grants on Finance's side (ADR 0045 §4). Finance is the authority for "these hotels
 * belong to this payer": it checks the pair against its own data, then calls the core, which
 * stores the grant and is the authority for "this account may see them". Finance stores nothing of
 * its own here and never holds a database transaction while it calls the core.
 *
 * A new grant: a request the core already performed returns its stored result (read only) →
 * otherwise the pair checked → the account (created when new) → the grant (idempotent per
 * requestId at the core) → the invitation, only after the grant is written. A retry of the same
 * request repeats every step with the same ids and the same result.
 */
@Injectable()
export class FinancePortalGrantsService {
  private readonly logger = new Logger(FinancePortalGrantsService.name);

  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly core: CoreClient,
  ) {}

  /**
   * The payer page's "Přístup do portálu": its grants, the hotels a grant may name now (the same
   * computation as the check) and the names of every hotel shown — also of a hotel a grant still
   * names after the payer's agreement ended, so that grant can always be seen and revoked.
   */
  async ofPayer(caller: FinanceCaller, payerCustomerId: string): Promise<FinancePortalAccess> {
    await this.payer(payerCustomerId);
    const [grants, hotels] = await Promise.all([
      this.core.portalGrantsOfPayer(caller.sessionToken, payerCustomerId),
      this.payerHotels(payerCustomerId),
    ]);
    const names: Record<string, string> = Object.fromEntries(
      [...hotels.values()].map((h) => [h.id, h.name]),
    );
    const unknown = [...new Set(grants.flatMap((g) => g.hotelIds))].filter((id) => !names[id]);
    for (const [id, h] of await this.core.lookupHotels(caller.sessionToken, unknown))
      names[id] = h.name;
    return { grants, payerHotels: [...hotels.values()], hotelNames: names };
  }

  /**
   * A new grant. A retry of a request the core already performed (its answer was lost) gets the
   * stored grant first — read only, before the pair is checked again — so a later change of the
   * payer's agreements never turns a written grant into a refusal. A request not performed yet is
   * checked in full; nothing is bypassed.
   */
  async issue(
    caller: FinanceCaller,
    req: FinancePortalGrantIssue,
  ): Promise<FinancePortalGrantResult> {
    const performed = await this.core.performedPortalGrantRequest(caller.sessionToken, {
      kind: 'ISSUE',
      requestId: req.requestId,
      email: req.email,
      payerCustomerId: req.payerCustomerId,
      hotelIds: req.hotelIds,
      reason: req.reason,
    });
    const check = performed ? null : await this.checkPair(req.payerCustomerId, req.hotelIds);
    const account = await this.core.portalAccount(caller.sessionToken, {
      email: req.email,
      displayName: req.displayName,
    });
    const grant =
      performed ??
      (await this.core.issuePortalGrant(caller.sessionToken, {
        requestId: req.requestId,
        userId: account.userId,
        payerCustomerId: req.payerCustomerId,
        hotelIds: req.hotelIds,
        reason: req.reason,
        financeCheck: check!,
      }));
    return {
      grant,
      account: { userId: account.userId, email: account.email, displayName: account.displayName },
      invitation: await this.invite(caller, account.userId, req.requestId),
    };
  }

  /** A changed hotel set (also narrowed): the same check against the grant's own payer. */
  async replace(
    caller: FinanceCaller,
    grantId: string,
    req: FinancePortalGrantReplace,
  ): Promise<FinancePortalGrantResult> {
    const old = await this.core.portalGrant(caller.sessionToken, grantId);
    // A retry of a replacement already performed: its stored successor, read only (as for issue).
    const performed = await this.core.performedPortalGrantRequest(caller.sessionToken, {
      kind: 'REPLACE',
      requestId: req.requestId,
      grantId,
      payerCustomerId: old.payerCustomerId,
      hotelIds: req.hotelIds,
      reason: req.reason,
    });
    if (performed) return { grant: performed, account: null, invitation: null };
    const check = await this.checkPair(old.payerCustomerId, req.hotelIds);
    const grant = await this.core.replacePortalGrant(caller.sessionToken, grantId, {
      requestId: req.requestId,
      payerCustomerId: old.payerCustomerId,
      hotelIds: req.hotelIds,
      reason: req.reason,
      financeCheck: check,
    });
    return { grant, account: null, invitation: null };
  }

  /** A new invitation attempt (its own request id) for the account of an active grant. */
  async reinvite(
    caller: FinanceCaller,
    grantId: string,
    requestId: string,
  ): Promise<{ invitation: Invitation }> {
    const grant = await this.core.portalGrant(caller.sessionToken, grantId);
    if (grant.revokedAt) throw domainError(409, 'GRANT_REVOKED', 'The grant was revoked');
    const { state } = await this.core.invitePortalAccount(
      caller.sessionToken,
      grant.userId,
      requestId,
    );
    return { invitation: state };
  }

  /**
   * The grant is written: only now the invitation, under an id derived from the request's, so a
   * retry of the same request repeats the same invitation (UNCERTAIN → the same again). FAILED is
   * final for this request; a new attempt is `reinvite` with a new id.
   */
  private async invite(caller: FinanceCaller, userId: string, requestId: string) {
    try {
      const { state } = await this.core.invitePortalAccount(
        caller.sessionToken,
        userId,
        derivedRequestId(requestId, 'portal-invitation'),
      );
      return state;
    } catch (error) {
      this.logger.warn(`Portal invitation without an answer: ${(error as Error).name}`);
      return 'UNCERTAIN' as const;
    }
  }

  // --- the pair: payer and hotels, from Finance's own data ------------------------------------

  private async payer(payerCustomerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: payerCustomerId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } } },
    });
    // Finance has no archiving of customers: PAYER_ARCHIVED (ADR §4) cannot arise yet.
    if (!customer || customer.versions.length === 0)
      throw domainError(404, 'PAYER_NOT_FOUND', 'No such payer');
    return { payerVersion: customer.versions[0]!.version };
  }

  /**
   * The hotels that belong to the payer now, from Finance's own data: its billing agreement's terms
   * in effect today name this payer and are valid today (AGREEMENT) — or an invoice already issued
   * to this payer lists the hotel (INVOICE). The check of a grant and the payer page use this one
   * computation.
   */
  private async payerHotels(
    payerCustomerId: string,
  ): Promise<Map<string, FinancePortalPayerHotel>> {
    const today = pragueToday();
    const now = new Date();
    const agreements = await this.prisma.billingAgreement.findMany({
      where: { versions: { some: { customerId: payerCustomerId } } },
      include: { versions: true },
    });
    const hotels = new Map<string, FinancePortalPayerHotel>();
    for (const a of agreements) {
      const v = effectiveAt(a.versions, today, now);
      if (
        v !== null &&
        v.customerId === payerCustomerId &&
        v.validFrom <= today &&
        (v.validTo === null || v.validTo >= today)
      )
        hotels.set(a.hotelId, {
          id: a.hotelId,
          code: a.hotelCode,
          name: a.hotelName,
          basis: 'AGREEMENT',
        });
    }
    const lines = await this.prisma.invoiceLine.findMany({
      where: { invoice: { customerId: payerCustomerId } },
      select: { hotelId: true, hotelCode: true, hotelName: true },
      distinct: ['hotelId'],
    });
    for (const l of lines)
      if (!hotels.has(l.hotelId))
        hotels.set(l.hotelId, {
          id: l.hotelId,
          code: l.hotelCode,
          name: l.hotelName,
          basis: 'INVOICE',
        });
    return hotels;
  }

  /** Each hotel belongs to the payer (above), else HOTEL_NOT_OF_PAYER and nothing goes to the core. */
  private async checkPair(payerCustomerId: string, hotelIds: readonly string[]) {
    const { payerVersion } = await this.payer(payerCustomerId);
    const hotels = await this.payerHotels(payerCustomerId);
    const foreign = hotelIds.filter((h) => !hotels.has(h)).sort();
    if (foreign.length > 0)
      throw domainErrorWithDetails(
        409,
        'HOTEL_NOT_OF_PAYER',
        'Some hotels do not belong to this payer',
        { hotelIds: foreign },
      );
    return { payerVersion, hotelIds: [...hotelIds].sort(), checkedAt: new Date().toISOString() };
  }
}
