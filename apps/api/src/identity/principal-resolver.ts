import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { AccessService } from './access.service.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import type { Principal } from './principal.js';
import { SessionsService } from './sessions.service.js';

export type Resolution =
  | { kind: 'principal'; principal: Principal }
  | { kind: 'anonymous' }
  | { kind: 'expired' }
  | { kind: 'inactive' };

/**
 * Turns the session cookie of a request into the current principal. The identity comes ONLY from
 * the AYVO session cookie; headers such as X-User-Id or Authorization are never consulted.
 */
@Injectable()
export class PrincipalResolver {
  constructor(
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
  ) {}

  async resolve(req: IncomingMessage): Promise<Resolution> {
    const lookup = await this.sessions.lookup(readCookie(req, SESSION_COOKIE));
    if (lookup.kind === 'none') return { kind: 'anonymous' };
    if (lookup.kind === 'expired') return { kind: 'expired' };
    if (lookup.kind === 'inactive') return { kind: 'inactive' };
    const snapshot = await this.access.snapshot(lookup.user.id);
    return {
      kind: 'principal',
      principal: {
        userId: lookup.user.id,
        email: lookup.user.email,
        displayName: lookup.user.displayName,
        sessionId: lookup.sessionId,
        ...snapshot,
        idleExpiresAt: lookup.idleExpiresAt,
        absoluteExpiresAt: lookup.absoluteExpiresAt,
      },
    };
  }
}
