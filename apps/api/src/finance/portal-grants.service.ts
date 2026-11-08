import { createHash } from 'node:crypto';
import type {
  FinancePortalGrantIssue,
  FinancePortalGrantReplace,
  FinancePortalGrantResult,
  PortalGrantListItem,
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

/**
 * Hotel portal grants on Finance's side (ADR 0045 §4). Finance is the authority for "these hotels
 * belong to this payer": it checks the pair against its own data, then calls the core, which
 * stores the grant and is the authority for "this account may see them". Finance stores nothing of
 * its own here and never holds a database transaction while it calls the core.
 *
 * A new grant: the account (created when new) → the pair checked → the grant (idempotent per
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

  /** The payer's grants (its page "Přístup do portálu"); an unknown payer → PAYER_NOT_FOUND. */
  async ofPayer(caller: FinanceCaller, payerCustomerId: string): Promise<PortalGrantListItem[]> {
    await this.payer(payerCustomerId);
    return this.core.portalGrantsOfPayer(caller.sessionToken, payerCustomerId);
  }

  async issue(
    caller: FinanceCaller,
    req: FinancePortalGrantIssue,
  ): Promise<FinancePortalGrantResult> {
    const check = await this.checkPair(req.payerCustomerId, req.hotelIds);
    const account = await this.core.portalAccount(caller.sessionToken, {
      email: req.email,
      displayName: req.displayName,
    });
    const grant = await this.core.issuePortalGrant(caller.sessionToken, {
      requestId: req.requestId,
      userId: account.userId,
      payerCustomerId: req.payerCustomerId,
      hotelIds: req.hotelIds,
      reason: req.reason,
      financeCheck: check,
    });
    // The grant is written: only now the invitation. Its failure leaves the grant in place; the
    // same request retried sends it (the same derived id), never a second one.
    let invitation: FinancePortalGrantResult['invitation'];
    try {
      invitation = (
        await this.core.invitePortalAccount(
          caller.sessionToken,
          account.userId,
          derivedRequestId(req.requestId, 'portal-invitation'),
        )
      ).state;
    } catch (error) {
      this.logger.warn(`Portal invitation not sent: ${(error as Error).name}`);
      invitation = 'FAILED';
    }
    return {
      grant,
      account: { userId: account.userId, email: account.email, displayName: account.displayName },
      invitation,
    };
  }

  /** A changed hotel set (also narrowed): the same check against the grant's own payer. */
  async replace(
    caller: FinanceCaller,
    grantId: string,
    req: FinancePortalGrantReplace,
  ): Promise<FinancePortalGrantResult> {
    const old = await this.core.portalGrant(caller.sessionToken, grantId);
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
   * Each hotel belongs to the payer: its billing agreement's terms in effect today name this payer
   * and are valid today — or an invoice already issued to this payer lists the hotel. Otherwise
   * HOTEL_NOT_OF_PAYER with those hotels, and nothing is sent to the core.
   */
  private async checkPair(payerCustomerId: string, hotelIds: readonly string[]) {
    const { payerVersion } = await this.payer(payerCustomerId);
    const today = pragueToday();
    const now = new Date();
    const agreements = await this.prisma.billingAgreement.findMany({
      where: { hotelId: { in: [...hotelIds] } },
      include: { versions: true },
    });
    const byAgreement = new Set(
      agreements
        .filter((a) => {
          const v = effectiveAt(a.versions, today, now);
          return (
            v !== null &&
            v.customerId === payerCustomerId &&
            v.validFrom <= today &&
            (v.validTo === null || v.validTo >= today)
          );
        })
        .map((a) => a.hotelId),
    );
    const rest = hotelIds.filter((h) => !byAgreement.has(h));
    const invoiced = new Set(
      rest.length === 0
        ? []
        : (
            await this.prisma.invoiceLine.findMany({
              where: { hotelId: { in: rest }, invoice: { customerId: payerCustomerId } },
              select: { hotelId: true },
              distinct: ['hotelId'],
            })
          ).map((l) => l.hotelId),
    );
    const foreign = rest.filter((h) => !invoiced.has(h)).sort();
    if (foreign.length > 0)
      throw domainErrorWithDetails(
        409,
        'HOTEL_NOT_OF_PAYER',
        'Some hotels do not belong to this payer',
        { hotelIds: foreign },
      );
    return { payerVersion, hotelIds: [...hotelIds].sort(), checkedAt: now.toISOString() };
  }
}
