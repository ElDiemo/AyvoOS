import { PORTAL_SESSION_HEADER, type PortalIntrospection } from '@ayvo/types';
import { Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { FinancePortalAccess } from '../identity/access.decorators.js';
import { accountInactive, sessionExpired, unauthenticated } from '../identity/access.guard.js';
import { SessionsService } from '../identity/sessions.service.js';
import { PortalGrantsService } from '../portal-grants/portal-grants.service.js';
import { PortalPrismaService } from './portal-prisma.service.js';
import { PortalRequestLimit } from './portal-request-limit.js';
import { PORTAL_SESSIONS } from './portal-tokens.js';

/**
 * `introspect-portal` (ADR 0045 §5, §6): Finance asks, on every portal request it serves, what the
 * forwarded PORTAL session may see — the account's active grants now. A STAFF session, or none, is
 * 401. A valid session without a grant gets an empty list: nothing is visible. It is portal work:
 * the portal's request slots and reserved pool, never a staff connection.
 */
@Controller('internal/v1/finance')
export class PortalIntrospectionController {
  constructor(
    @Inject(PORTAL_SESSIONS) private readonly sessions: SessionsService,
    private readonly grants: PortalGrantsService,
    private readonly slots: PortalRequestLimit,
    private readonly db: PortalPrismaService,
  ) {}

  @FinancePortalAccess()
  @Post('introspect-portal')
  @HttpCode(200)
  introspect(
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalIntrospection> {
    return this.slots.run(async () => {
      const session = await this.sessions.lookup(token ?? null, 'PORTAL');
      if (session.kind === 'expired') throw sessionExpired();
      if (session.kind === 'inactive') throw accountInactive();
      if (session.kind !== 'active') throw unauthenticated();
      return {
        userId: session.user.id,
        // Invoices: every hotel of the grant — operational or invoices only (v6, #148).
        grants: (await this.grants.activeOf(session.user.id, this.db)).map((g) => ({
          id: g.id,
          payerCustomerId: g.payerCustomerId,
          hotelIds: g.hotelIds,
        })),
      };
    });
  }
}
