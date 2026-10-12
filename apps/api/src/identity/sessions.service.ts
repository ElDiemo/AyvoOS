import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { randomToken, sha256Hex } from './crypto.js';

export type SessionLookup =
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'inactive'; userId: string }
  | {
      kind: 'active';
      sessionId: string;
      user: { id: string; email: string; displayName: string };
      activeSiteId: string | null;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
    };

/** Activity is recorded at most this often, so ordinary requests do not write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * AYVO application sessions (ADR 0022). The cookie carries 256 random bits; the database keeps
 * only their SHA-256. Every request re-checks expiry, revocation and the user's status.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(
    tx: Prisma.TransactionClient,
    input: { userId: string; identityId: string; providerSessionId: string | null },
  ): Promise<{ token: string; sessionId: string; maxAgeSeconds: number }> {
    const token = randomToken();
    const now = Date.now();
    const absolute = new Date(now + this.env.SESSION_ABSOLUTE_HOURS * 3_600_000);
    const idle = new Date(
      Math.min(now + this.env.SESSION_IDLE_MINUTES * 60_000, absolute.getTime()),
    );
    const session = await tx.userSession.create({
      data: {
        tokenSha256: sha256Hex(token),
        userId: input.userId,
        identityId: input.identityId,
        providerSessionId: input.providerSessionId,
        idleExpiresAt: idle,
        absoluteExpiresAt: absolute,
      },
    });
    return { token, sessionId: session.id, maxAgeSeconds: (absolute.getTime() - now) / 1000 };
  }

  async lookup(token: string | null): Promise<SessionLookup> {
    if (!token) return { kind: 'none' };
    const session = await this.prisma.userSession.findUnique({
      where: { tokenSha256: sha256Hex(token) },
      include: { user: { select: { id: true, email: true, displayName: true, status: true } } },
    });
    if (!session) return { kind: 'none' };
    if (session.revokedAt) {
      if (session.revokeReason === 'LOGOUT') return { kind: 'none' };
      // A deactivated user learns why access ended, not merely that the session is gone.
      if (session.user.status !== 'ACTIVE') return { kind: 'inactive', userId: session.user.id };
      return { kind: 'expired' };
    }
    const now = new Date();
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      await this.revoke(session.id, 'EXPIRED');
      return { kind: 'expired' };
    }
    if (session.user.status !== 'ACTIVE') {
      await this.revoke(session.id, 'USER_DEACTIVATED');
      return { kind: 'inactive', userId: session.user.id };
    }
    let idleExpiresAt = session.idleExpiresAt;
    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      idleExpiresAt = new Date(
        Math.min(
          now.getTime() + this.env.SESSION_IDLE_MINUTES * 60_000,
          session.absoluteExpiresAt.getTime(),
        ),
      );
      await this.prisma.userSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { lastSeenAt: now, idleExpiresAt },
      });
    }
    return {
      kind: 'active',
      sessionId: session.id,
      user: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
      },
      activeSiteId: session.activeSiteId,
      idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  /** Remembers the site this session works at (the caller has authorized it). */
  setActiveSite(sessionId: string, siteId: string) {
    return this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { activeSiteId: siteId },
    });
  }

  async revoke(sessionId: string, reason: string, db: Prisma.TransactionClient = this.prisma) {
    return db.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** Ends every open session of a user (deactivation). */
  revokeAllForUser(userId: string, reason: string, db: Prisma.TransactionClient = this.prisma) {
    return db.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  countActive(userId: string) {
    return this.prisma.userSession.count({
      where: {
        userId,
        revokedAt: null,
        idleExpiresAt: { gt: new Date() },
        absoluteExpiresAt: { gt: new Date() },
      },
    });
  }
}
