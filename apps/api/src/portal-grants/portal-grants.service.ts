import type {
  PortalGrant,
  PortalGrantFinanceCheck,
  PortalGrantIssueRequest,
  PortalGrantReplaceRequest,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type AccountAudience } from '../generated/prisma/client.js';
import { SessionsService } from '../identity/sessions.service.js';

type Tx = Prisma.TransactionClient;
type GrantRow = Prisma.PortalGrantGetPayload<{ include: { hotels: true } }>;

/** The reason recorded on a grant that a new one replaced. */
export const REPLACED_REASON = 'nahrazen';

const toView = (g: GrantRow): PortalGrant => ({
  id: g.id,
  userId: g.userId,
  payerCustomerId: g.payerCustomerId,
  hotelIds: g.hotels.map((h) => h.hotelId).sort(),
  reason: g.reason,
  financeCheck: g.financeCheck as PortalGrantFinanceCheck,
  grantedAt: g.grantedAt.toISOString(),
  grantedBy: g.grantedBy,
  replacesGrantId: g.replacesId,
  revokedAt: g.revokedAt?.toISOString() ?? null,
  revokedBy: g.revokedBy,
  revokeReason: g.revokeReason,
});

/**
 * Hotel portal grants (ADR 0045 §4). The core stores them and is their authority; issuing and
 * replacing come only through Finance's contract call (Finance has checked the payer and its
 * hotels), revocation from the core's admin route. Every change runs in one transaction with the
 * fixed lock order: the account's user row, then the grant row. A grant is never edited or
 * revived (also DB); one active grant per (user, payer) (DB).
 */
@Injectable()
export class PortalGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly operations: OperationRequestsService,
  ) {}

  /**
   * A new grant. Idempotent per `requestId`: the same actor, account, payer and scope get the
   * stored result again (one grant, one audit event); anything else under that id is
   * IDEMPOTENCY_CONFLICT.
   */
  async issue(actorId: string, input: PortalGrantIssueRequest): Promise<PortalGrant> {
    const meaning = { actorId, userId: input.userId, ...scopeOf(input) };
    return this.idempotent('PORTAL_GRANT_ISSUE', input.requestId, meaning, async (tx) => {
      await this.lockAccount(tx, input.userId);
      await this.requireHotels(tx, input.hotelIds);
      const open = await tx.portalGrant.findFirst({
        where: { userId: input.userId, payerCustomerId: input.payerCustomerId, revokedAt: null },
        select: { id: true },
      });
      if (open) throw grantExists(open.id);
      const grant = await this.create(tx, actorId, input.userId, input, null);
      await this.audit.record(
        {
          type: 'PORTAL_GRANT_ISSUED',
          actorUserId: actorId,
          targetUserId: input.userId,
          reason: input.reason,
          payload: {
            grantId: grant.id,
            payerCustomerId: input.payerCustomerId,
            hotelIds: grant.hotelIds,
          },
        },
        tx,
      );
      return grant;
    });
  }

  /**
   * An atomic replacement: the new hotel set as a new grant, the old one revoked "nahrazen".
   * Idempotent per `requestId` like `issue` (the replaced grant is part of its meaning).
   */
  async replace(
    actorId: string,
    grantId: string,
    input: PortalGrantReplaceRequest,
  ): Promise<PortalGrant> {
    const meaning = { actorId, grantId, ...scopeOf(input) };
    return this.idempotent('PORTAL_GRANT_REPLACE', input.requestId, meaning, async (tx) => {
      const old = await this.lockGrant(tx, grantId);
      if (old.payerCustomerId !== input.payerCustomerId)
        throw domainError(409, 'GRANT_PAYER_MISMATCH', 'A replacement keeps the payer');
      await this.requireHotels(tx, input.hotelIds);
      const previous = old.hotels.map((h) => h.hotelId).sort();
      await tx.portalGrant.update({
        where: { id: old.id },
        data: { revokedAt: new Date(), revokedBy: actorId, revokeReason: REPLACED_REASON },
      });
      const grant = await this.create(tx, actorId, old.userId, input, old.id);
      await this.audit.record(
        {
          type: 'PORTAL_GRANT_REPLACED',
          actorUserId: actorId,
          targetUserId: old.userId,
          reason: input.reason,
          payload: {
            grantId: grant.id,
            replacedGrantId: old.id,
            payerCustomerId: old.payerCustomerId,
            hotelIds: grant.hotelIds,
            previousHotelIds: previous,
          },
        },
        tx,
      );
      return grant;
    });
  }

  /**
   * Revocation (core only). When the account has no active grant left, every portal session of it
   * ends in the same transaction.
   */
  async revoke(actorId: string, grantId: string, reason: string): Promise<PortalGrant> {
    return this.write(async (tx) => {
      const old = await this.lockGrant(tx, grantId, { activeAccount: false });
      await tx.portalGrant.update({
        where: { id: old.id },
        data: { revokedAt: new Date(), revokedBy: actorId, revokeReason: reason },
      });
      const left = await tx.portalGrant.count({ where: { userId: old.userId, revokedAt: null } });
      const ended =
        left === 0
          ? (await this.sessions.revokeAllForUser(old.userId, 'PORTAL_GRANT_REVOKED', tx)).count
          : 0;
      await this.audit.record(
        {
          type: 'PORTAL_GRANT_REVOKED',
          actorUserId: actorId,
          targetUserId: old.userId,
          reason,
          payload: { grantId: old.id, payerCustomerId: old.payerCustomerId, sessionsEnded: ended },
        },
        tx,
      );
      return toView(
        await tx.portalGrant.findUniqueOrThrow({
          where: { id: old.id },
          include: { hotels: true },
        }),
      );
    });
  }

  // --- internals ---------------------------------------------------------------------------

  /**
   * One transaction, exactly once per request id (doc 018 §8): the request row first, then the
   * account and grant locks. A refusal rolls everything back, the request row included.
   */
  private async idempotent(
    kind: 'PORTAL_GRANT_ISSUE' | 'PORTAL_GRANT_REPLACE',
    requestId: string,
    meaning: unknown,
    work: (tx: Tx) => Promise<PortalGrant>,
  ): Promise<PortalGrant> {
    try {
      const { result } = await this.operations.run(
        kind,
        requestId,
        meaning,
        async (tx) => (await work(tx)) as unknown as Prisma.InputJsonObject,
      );
      return result as unknown as PortalGrant;
    } catch (error) {
      throw mapUniqueViolation(error);
    }
  }

  /** One transaction; a concurrent second active grant (unique index) is reported as such. */
  private async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (error) {
      throw mapUniqueViolation(error);
    }
  }

  /** The account's user row lock — first, always. Only an active PORTAL account takes grants. */
  private async lockAccount(tx: Tx, userId: string, options = { activeAccount: true }) {
    const rows = await tx.$queryRaw<{ status: string; audience: AccountAudience }[]>`
      SELECT "status"::text AS "status", "audience"::text AS "audience"
      FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
    const user = rows[0];
    if (!user) throw domainError(404, 'USER_NOT_FOUND', 'No such user');
    if (user.audience !== 'PORTAL')
      throw domainError(
        409,
        'ACCOUNT_AUDIENCE_MISMATCH',
        'Portal grants are only for hotel portal accounts',
      );
    if (options.activeAccount && user.status !== 'ACTIVE')
      throw domainError(409, 'USER_INACTIVE', 'A deactivated account takes no new grant');
  }

  /**
   * The grant, locked after its account (user row → grant row). Already revoked: replaced → the
   * successor's id (the admin decides again), otherwise GRANT_REVOKED; nothing is written.
   */
  private async lockGrant(tx: Tx, grantId: string, options = { activeAccount: true }) {
    const found = await tx.portalGrant.findUnique({
      where: { id: grantId },
      select: { userId: true },
    });
    if (!found) throw domainError(404, 'GRANT_NOT_FOUND', 'No such portal grant');
    await this.lockAccount(tx, found.userId, options);
    await tx.$queryRaw`SELECT 1 FROM "portal_grants" WHERE "id" = ${grantId}::uuid FOR UPDATE`;
    const grant = await tx.portalGrant.findUniqueOrThrow({
      where: { id: grantId },
      include: { hotels: true, replacedBy: { select: { id: true } } },
    });
    if (grant.revokedAt) {
      if (grant.replacedBy)
        throw domainErrorWithDetails(
          409,
          'GRANT_REPLACED',
          'The grant was replaced in the meantime; decide again on the current one',
          { grantId: grant.replacedBy.id },
        );
      throw domainError(409, 'GRANT_REVOKED', 'The grant was revoked');
    }
    return grant;
  }

  private async requireHotels(tx: Tx, hotelIds: readonly string[]) {
    const found = await tx.hotel.count({ where: { id: { in: [...hotelIds] } } });
    if (found !== hotelIds.length) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
  }

  private async create(
    tx: Tx,
    actorId: string,
    userId: string,
    input: PortalGrantReplaceRequest,
    replacesId: string | null,
  ): Promise<PortalGrant> {
    const grant = await tx.portalGrant.create({
      data: {
        userId,
        payerCustomerId: input.payerCustomerId,
        grantedBy: actorId,
        reason: input.reason,
        financeCheck: input.financeCheck,
        replacesId,
        hotels: { create: input.hotelIds.map((hotelId) => ({ hotelId })) },
      },
      include: { hotels: true },
    });
    return toView(grant);
  }
}

/** What a request means, for its idempotency (hotel lists as sets). */
const scopeOf = (input: PortalGrantReplaceRequest) => ({
  payerCustomerId: input.payerCustomerId,
  hotelIds: [...input.hotelIds].sort(),
  reason: input.reason,
  financeCheck: { ...input.financeCheck, hotelIds: [...input.financeCheck.hotelIds].sort() },
});

/** A concurrent second active grant (unique index) is reported as such. */
const mapUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    ? grantExists(null)
    : error;

const grantExists = (grantId: string | null) =>
  domainErrorWithDetails(
    409,
    'GRANT_EXISTS',
    'The account already has an active grant for this payer; replace it instead',
    { grantId },
  );
