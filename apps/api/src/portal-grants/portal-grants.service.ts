import type {
  PortalGrantPerformed,
  PortalGrantRequestLookup,
  PortalAccount,
  PortalAccountRequest,
  PortalAccountListItem,
  PortalGrantListItem,
  PortalInvitation,
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
import { InvitationsService } from '../identity/invitations.service.js';
import { MAIL_DELIVERY_ATTEMPTS } from '../identity/native-tokens.service.js';
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
/** What the invitation state of an account is computed from. */
const invitationSelect = {
  nativeCredential: { select: { userId: true } },
  invitations: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { state: true, providerInvitationId: true, expiresAt: true },
  },
  nativeTokens: {
    where: { purpose: 'ENROLL' },
    select: {
      id: true,
      sentAt: true,
      deliveryAttempts: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
    },
  },
} satisfies Prisma.UserSelect;
type InvitationState = PortalGrantListItem['account']['invitation'];

function invitationOf(
  u: Prisma.UserGetPayload<{ select: typeof invitationSelect }>,
  now: Date,
): InvitationState {
  if (u.nativeCredential) return 'ACTIVE';
  const latest = u.invitations[0];
  if (!latest) return 'NONE';
  if (latest.state === 'FAILED') return 'FAILED';
  if (latest.state === 'EXPIRED') return 'EXPIRED';
  if (latest.state === 'SENDING') return 'QUEUED';
  if (latest.state !== 'PENDING') return 'NONE';
  if (latest.expiresAt && latest.expiresAt <= now) return 'EXPIRED';
  // The local provider's link mail goes out from the outbox (its token).
  const token = u.nativeTokens.find((t) => t.id === latest.providerInvitationId);
  if (!token || token.usedAt || token.revokedAt) return 'NONE';
  if (token.expiresAt <= now) return 'EXPIRED';
  if (token.sentAt) return 'ACCEPTED_BY_SERVER';
  // The outbox stops after this many attempts (NativeTokensService.deliverPending).
  if (token.deliveryAttempts >= MAIL_DELIVERY_ATTEMPTS) return 'DELIVERY_FAILED';
  return 'QUEUED';
}

@Injectable()
export class PortalGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly operations: OperationRequestsService,
    private readonly invitations: InvitationsService,
  ) {}

  // --- the hotel portal account -------------------------------------------------------------

  /**
   * The PORTAL account of this e-mail; created (no role, no credential, no invitation yet) when
   * none exists. An internal (STAFF) account's e-mail is refused, EMAIL_IS_STAFF (ADR 0045 §2):
   * the unique e-mail index decides a concurrent race, and the loser reads the winner's account.
   */
  async ensureAccount(actorId: string, input: PortalAccountRequest): Promise<PortalAccount> {
    const existing = async () => {
      const user = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (!user) return null;
      if (user.audience !== 'PORTAL')
        throw domainError(
          409,
          'EMAIL_IS_STAFF',
          'This e-mail belongs to an internal AYVO account; a hotel portal account needs another',
        );
      if (user.status !== 'ACTIVE')
        throw domainError(409, 'USER_INACTIVE', 'This hotel portal account is deactivated');
      return { userId: user.id, email: user.email, displayName: user.displayName, created: false };
    };
    const found = await existing();
    if (found) return found;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            displayName: input.displayName,
            audience: 'PORTAL',
            createdBy: actorId,
          },
        });
        await this.audit.record(
          {
            type: 'USER_CREATED',
            actorUserId: actorId,
            targetUserId: user.id,
            reason: 'Hotel portal account (with its first grant)',
            payload: { audience: 'PORTAL' },
          },
          tx,
        );
        return { userId: user.id, email: user.email, displayName: user.displayName, created: true };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await existing();
        if (winner) return winner;
      }
      throw error;
    }
  }

  /**
   * Invites the account to the portal — only while it holds an active grant, so an invitation
   * always follows a written grant (§4). Idempotent per `requestId` (the invitation's own request
   * id). An account that already signs in, or has an invitation on its way, is not invited again.
   */
  async invite(
    actorId: string,
    userId: string,
    requestId: string,
    retry = false,
  ): Promise<PortalInvitation> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { nativeCredential: { select: { userId: true } } },
    });
    if (!user) throw domainError(404, 'USER_NOT_FOUND', 'No such user');
    if (user.audience !== 'PORTAL')
      throw domainError(409, 'ACCOUNT_AUDIENCE_MISMATCH', 'Not a hotel portal account');
    if (user.status !== 'ACTIVE')
      throw domainError(409, 'USER_INACTIVE', 'This hotel portal account is deactivated');
    if (user.nativeCredential) return { state: 'ACTIVE' };
    if ((await this.prisma.portalGrant.count({ where: { userId, revokedAt: null } })) === 0)
      throw domainError(
        409,
        'NO_ACTIVE_GRANT',
        'A hotel portal account is invited only with a grant',
      );
    // A mail still in the outbox is not rotated under the worker's feet: it is on its way.
    if (retry && (await this.invitationState(userId)) === 'QUEUED') return { state: 'OPEN' };
    try {
      // A targeted retry resends an open invitation with a rotated link (the old link stops
      // working) or replaces an expired / failed / revoked one; never a second valid link.
      await (retry ? this.invitations.resend : this.invitations.send).call(
        this.invitations,
        actorId,
        userId,
        requestId,
        'Pozvánka do hotelového portálu',
        'PORTAL',
      );
      return { state: 'SENT' };
    } catch (error) {
      const code = (error as { getResponse?: () => { code?: string } }).getResponse?.().code;
      if (code === 'INVITATION_OPEN') return { state: 'OPEN' };
      if (code === 'ALREADY_LINKED' || code === 'INVITATION_ACCEPTED') return { state: 'ACTIVE' };
      // Refused for good: this request id answers so forever; a new attempt has a new id.
      if (code === 'INVITATION_PROVIDER_FAILED') return { state: 'FAILED' };
      // No definite answer (the provider may have acted, or the same attempt still runs): the
      // same request id reconciles.
      if (code === 'INVITATION_PROVIDER_UNAVAILABLE' || code === 'INVITATION_IN_PROGRESS')
        return { state: 'UNCERTAIN' };
      throw error;
    }
  }

  // --- reading (Finance's payer page) ---------------------------------------------------------

  /**
   * The stored result of a grant request the core already performed (read only), for Finance's
   * retry after a lost answer: the same actor and meaning as the original, else
   * IDEMPOTENCY_CONFLICT; never performed → 404 REQUEST_NOT_FOUND.
   */
  async performed(actorId: string, req: PortalGrantRequestLookup): Promise<PortalGrantPerformed> {
    const scope = {
      payerCustomerId: req.payerCustomerId,
      hotelIds: [...req.hotelIds].sort(),
      reason: req.reason,
    };
    let result: PortalGrant | null = null;
    if (req.kind === 'ISSUE') {
      const user = await this.prisma.user.findUnique({
        where: { email: req.email },
        select: { id: true },
      });
      if (user)
        result = await this.operations.peek<PortalGrant>('PORTAL_GRANT_ISSUE', req.requestId, {
          actorId,
          userId: user.id,
          ...scope,
        });
    } else {
      result = await this.operations.peek<PortalGrant>('PORTAL_GRANT_REPLACE', req.requestId, {
        actorId,
        grantId: req.grantId,
        ...scope,
      });
    }
    if (!result) throw domainError(404, 'REQUEST_NOT_FOUND', 'This request was not performed');
    // The stored result as it was, with the account and the grant as they are now (read only).
    const [account, grant] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: result.userId },
        select: { id: true, email: true, displayName: true, status: true },
      }),
      this.prisma.portalGrant.findUniqueOrThrow({
        where: { id: result.id },
        select: { revokedAt: true },
      }),
    ]);
    return {
      grant: result,
      account: {
        userId: account.id,
        email: account.email,
        displayName: account.displayName,
        active: account.status === 'ACTIVE',
      },
      grantActive: grant.revokedAt === null,
    };
  }

  /** The payer's grants, active first, with their accounts and invitation state. */
  async ofPayer(payerCustomerId: string): Promise<PortalGrantListItem[]> {
    const now = new Date();
    const rows = await this.prisma.portalGrant.findMany({
      where: { payerCustomerId },
      include: {
        hotels: true,
        user: { select: { email: true, displayName: true, ...invitationSelect } },
      },
      orderBy: [{ grantedAt: 'desc' }],
    });
    return rows
      .map((g) => ({
        ...toView(g),
        account: {
          email: g.user.email,
          displayName: g.user.displayName,
          signsIn: g.user.nativeCredential !== null,
          invitation: invitationOf(g.user, now),
        },
      }))
      .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null));
  }

  /**
   * Hotely → Uživatelé: every hotel portal (PORTAL) account — never an internal one — with all its
   * grants (active first) and their hotels' identity, its invitation and its open sessions. One
   * account (`only`) or all, by name. With `hotelId` (the hotel's card): only the accounts with an
   * active grant naming that hotel, each with only those grants — never the other accounts.
   */
  async accounts(only?: string, hotelId?: string): Promise<PortalAccountListItem[]> {
    const now = new Date();
    // One hotel's card: only accounts with an active grant naming it, and only those grants.
    const ofHotel = hotelId ? { revokedAt: null, hotels: { some: { hotelId } } } : undefined;
    const users = await this.prisma.user.findMany({
      where: {
        audience: 'PORTAL',
        ...(only ? { id: only } : {}),
        ...(ofHotel ? { portalGrants: { some: ofHotel } } : {}),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        deactivatedAt: true,
        deactivationReason: true,
        lastLoginAt: true,
        createdAt: true,
        ...invitationSelect,
        portalGrants: {
          ...(ofHotel ? { where: ofHotel } : {}),
          include: {
            hotels: { include: { hotel: { select: { id: true, code: true, name: true } } } },
          },
          orderBy: { grantedAt: 'desc' },
        },
      },
      orderBy: [{ status: 'asc' }, { displayName: 'asc' }, { email: 'asc' }],
    });
    const sessions = await this.prisma.userSession.groupBy({
      by: ['userId'],
      where: {
        userId: { in: users.map((u) => u.id) },
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      _count: { _all: true },
    });
    const open = new Map(sessions.map((s) => [s.userId, s._count._all]));
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      status: u.status,
      deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
      deactivationReason: u.deactivationReason,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      signsIn: u.nativeCredential !== null,
      invitation: invitationOf(u, now),
      activeSessions: open.get(u.id) ?? 0,
      grants: u.portalGrants
        .map((g) => ({
          id: g.id,
          payerCustomerId: g.payerCustomerId,
          hotels: g.hotels.map((h) => h.hotel).sort((a, b) => a.code.localeCompare(b.code)),
          grantedAt: g.grantedAt.toISOString(),
          revokedAt: g.revokedAt?.toISOString() ?? null,
          revokeReason: g.revokeReason,
        }))
        .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null)),
    }));
  }

  /** The account's invitation state now (see portalGrantListItemSchema). */
  async invitationState(userId: string): Promise<InvitationState> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: invitationSelect,
    });
    return invitationOf(user, new Date());
  }

  /** One grant (any state); unknown → 404. */
  async byId(grantId: string): Promise<PortalGrant> {
    const g = await this.prisma.portalGrant.findUnique({
      where: { id: grantId },
      include: { hotels: true },
    });
    if (!g) throw domainError(404, 'GRANT_NOT_FOUND', 'No such portal grant');
    return toView(g);
  }

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

  /**
   * The account's active grants now (read on every portal request). `db`: the caller's own client
   * (the hotel portal reads through its reserved pool).
   */
  async activeOf(
    userId: string,
    db: Tx = this.prisma,
  ): Promise<{ id: string; payerCustomerId: string; hotelIds: string[] }[]> {
    const rows = await db.portalGrant.findMany({
      where: { userId, revokedAt: null },
      include: { hotels: { select: { hotelId: true } } },
      orderBy: { grantedAt: 'asc' },
    });
    return rows.map((g) => ({
      id: g.id,
      payerCustomerId: g.payerCustomerId,
      hotelIds: g.hotels.map((h) => h.hotelId).sort(),
    }));
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

/**
 * What a request means, for its idempotency: who (the actor, added by the caller), which
 * operation on which account or grant (the caller), the payer, the hotels as a set and the reason.
 *
 * `financeCheck` is NOT part of it. It is Finance's evidence of a server-side check: when it was
 * made (`checkedAt`) and against which payer version (`payerVersion`). Finance makes the check
 * again before every attempt, including a safe retry after a lost answer, so the evidence of a
 * retry may be newer. Its hotels are always exactly the grant's (schema), so they are already in
 * the meaning. A replay of the same request therefore returns the ORIGINAL stored grant with its
 * ORIGINAL evidence — the one the grant was written on. Nothing of the retry's evidence is stored.
 * A changed payer version on a retry is still the same request: Finance has confirmed the same
 * payer and hotels again.
 */
const scopeOf = (input: PortalGrantReplaceRequest) => ({
  payerCustomerId: input.payerCustomerId,
  hotelIds: [...input.hotelIds].sort(),
  reason: input.reason,
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
