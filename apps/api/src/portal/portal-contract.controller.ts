import type { ServerResponse } from 'node:http';
import {
  PORTAL_SESSION_HEADER,
  portalActionRequestSchema,
  portalForgotRequestSchema,
  portalHotelProfileRequestSchema,
  portalLogoutRequestSchema,
  portalMfaRequestSchema,
  portalPasswordRequestSchema,
  type PortalActionRequest,
  type PortalChallengeStep,
  type PortalContract,
  type PortalDeliveries,
  type PortalClient,
  type PortalForgotRequest,
  type PortalHotel,
  type PortalHotelProfile,
  type PortalHotelProfileRequest,
  type PortalLogoutRequest,
  type PortalMfaRequest,
  type PortalMfaResult,
  type PortalPasswordRequest,
  type PortalSessionView,
} from '@ayvo/types';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ContractDraftsService } from '../contracts/contract-drafts.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { SupplyPlansService } from '../orders/supply-plans.service.js';
import { ENV, type Env } from '../config/env.js';
import { HotelsService } from '../customers/hotels.service.js';
import { PortalServiceAccess } from '../identity/access.decorators.js';
import {
  accountInactive,
  sameOriginRequest,
  sessionExpired,
  unauthenticated,
} from '../identity/access.guard.js';
import { AuthRateLimitService } from '../identity/auth-rate-limit.service.js';
import { sha256Hex } from '../identity/crypto.js';
import { NativeAuthService } from '../identity/native-auth.service.js';
import { PasswordWorkLimitError } from '../identity/native-credentials.js';
import { SessionsService } from '../identity/sessions.service.js';
import { PortalGrantsService } from '../portal-grants/portal-grants.service.js';
import { PORTAL_AUDIT, PORTAL_NATIVE_AUTH, PORTAL_SESSIONS } from './portal-tokens.js';
import { PortalPrismaService } from './portal-prisma.service.js';
import { PortalRequestLimit } from './portal-request-limit.js';

/** Seconds the pre-session step lives (as on the internal routes). */
const LOGIN_STEP_SECONDS = 300;
const ACTION_STEP_SECONDS = 900;

const denied = () =>
  domainError(401, 'INVALID_LOGIN', 'Přihlášení se nezdařilo. Zkontrolujte údaje.');

/**
 * The core's hotel portal contract (ADR 0045 §3, §6, §8), called only by portal-web with its own
 * token (`@PortalServiceAccess()`). Every step runs as PORTAL: an account, link, challenge or
 * session of the internal OS is unknown here (PR 1). Each route:
 * - holds one of the portal's request slots (`PortalRequestLimit`, the rest 503 at once);
 * - reads and writes only through the portal's reserved pool (`PortalPrismaService`, via the
 *   module's own service instances);
 * - checks the browser request portal-web forwards: Origin of the portal, and the sign-in rate
 *   limits per IP and per account, link or pending login (Redis, fail closed).
 * What a session may see is evaluated on every call from its active grants.
 */
@Controller('internal/v1/portal')
export class PortalContractController {
  constructor(
    @Inject(PORTAL_NATIVE_AUTH) private readonly auth: NativeAuthService,
    @Inject(PORTAL_SESSIONS) private readonly sessions: SessionsService,
    private readonly grants: PortalGrantsService,
    private readonly hotels: HotelsService,
    private readonly contracts: ContractDraftsService,
    private readonly orders: OrdersService,
    private readonly plans: SupplyPlansService,
    private readonly limits: AuthRateLimitService,
    private readonly slots: PortalRequestLimit,
    private readonly db: PortalPrismaService,
    @Inject(PORTAL_AUDIT) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- sign-in (no account oracle: unknown and known accounts answer alike) -----------------

  @PortalServiceAccess()
  @Post('auth/password')
  @HttpCode(200)
  password(
    @Body(new ZodValidationPipe(portalPasswordRequestSchema)) body: PortalPasswordRequest,
  ): Promise<PortalChallengeStep> {
    return this.slots.run(async () => {
      await this.browser(body.client, body.email);
      const result = await this.expensive(() =>
        this.auth.beginLogin(body.email, body.password, '/', 'PORTAL'),
      );
      if (!result) throw denied();
      return { step: 'MFA', challenge: result.token, maxAgeSeconds: LOGIN_STEP_SECONDS };
    });
  }

  @PortalServiceAccess()
  @Post('auth/activate')
  @HttpCode(200)
  activate(
    @Body(new ZodValidationPipe(portalActionRequestSchema)) body: PortalActionRequest,
  ): Promise<PortalChallengeStep> {
    return this.slots.run(async () => {
      await this.browser(body.client, body.token);
      const result = await this.expensive(() =>
        this.auth.beginAction('ENROLL', body.token, body.password, 'PORTAL'),
      );
      if (!result?.enrollmentUri)
        throw domainError(
          400,
          'INVALID_LINK',
          'Odkaz už neplatí. Požádejte AYVO o novou pozvánku.',
        );
      return {
        step: 'ENROLL_MFA',
        challenge: result.token,
        maxAgeSeconds: ACTION_STEP_SECONDS,
        qrDataUrl: await QRCode.toDataURL(result.enrollmentUri, {
          errorCorrectionLevel: 'M',
          width: 256,
        }),
        setupKey: new URL(result.enrollmentUri).searchParams.get('secret') ?? undefined,
      };
    });
  }

  @PortalServiceAccess()
  @Post('auth/forgot-password')
  @HttpCode(200)
  forgotPassword(
    @Body(new ZodValidationPipe(portalForgotRequestSchema)) body: PortalForgotRequest,
  ): Promise<{ message: string }> {
    return this.slots.run(async () => {
      await this.browser(body.client, body.email);
      await this.auth.requestPasswordReset(body.email, 'PORTAL');
      return { message: 'Pokud má tento e-mail aktivní účet, pošleme odkaz na obnovu hesla.' };
    });
  }

  @PortalServiceAccess()
  @Post('auth/reset-password')
  @HttpCode(200)
  resetPassword(
    @Body(new ZodValidationPipe(portalActionRequestSchema)) body: PortalActionRequest,
  ): Promise<PortalChallengeStep> {
    return this.slots.run(async () => {
      await this.browser(body.client, body.token);
      const result = await this.expensive(() =>
        this.auth.beginAction('RESET_PASSWORD', body.token, body.password, 'PORTAL'),
      );
      if (!result) throw domainError(400, 'INVALID_LINK', 'Odkaz už neplatí. Vyžádejte si nový.');
      return { step: 'MFA', challenge: result.token, maxAgeSeconds: ACTION_STEP_SECONDS };
    });
  }

  @PortalServiceAccess()
  @Post('auth/mfa')
  @HttpCode(200)
  mfa(
    @Body(new ZodValidationPipe(portalMfaRequestSchema)) body: PortalMfaRequest,
  ): Promise<PortalMfaResult> {
    return this.slots.run(async () => {
      // Origin and the IP limit first: a request refused there never reaches the database.
      await this.browser(body.client);
      const account = await this.auth.challengeAccount(body.challenge, 'PORTAL');
      if (account) await this.accountLimit(account);
      const result = await this.auth.complete(body.challenge, body.code.trim(), 'PORTAL');
      if (result.kind === 'denied')
        throw domainError(
          401,
          'INVALID_MFA',
          'Kód neplatí nebo vypršel. Zkuste nový kód, případně se přihlaste znovu.',
        );
      if (result.kind === 'reset') return { step: 'PASSWORD_RESET' };
      return {
        step: 'DONE',
        session: result.token,
        maxAgeSeconds: result.maxAgeSeconds,
        ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
      };
    });
  }

  /** Ends the forwarded portal session (idempotent: an unknown one is simply not there). */
  @PortalServiceAccess()
  @Post('auth/logout')
  @HttpCode(204)
  logout(
    @Body(new ZodValidationPipe(portalLogoutRequestSchema)) body: PortalLogoutRequest,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<void> {
    return this.slots.run(async () => {
      this.sameOrigin(body.client);
      const session = await this.sessions.lookup(token ?? null, 'PORTAL');
      if (session.kind !== 'active') return;
      await this.db.$transaction(async (tx) => {
        await this.sessions.revoke(session.sessionId, 'LOGOUT', tx);
        await this.audit.record(
          { type: 'LOGOUT', actorUserId: session.user.id, targetUserId: session.user.id },
          tx,
        );
      });
    });
  }

  // --- the session and "Moje hotely" (read only) --------------------------------------------

  /** The forwarded portal session and its active grants, now. */
  @PortalServiceAccess()
  @Get('session')
  session(@Headers(PORTAL_SESSION_HEADER) token: string | undefined): Promise<PortalSessionView> {
    return this.slots.run(async () => {
      const session = await this.portalSession(token);
      return {
        user: session.user,
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
        grants: (await this.grants.activeOf(session.user.id, this.db)).map(scopeOf),
      };
    });
  }

  /**
   * The hotels of the session's active grants that are operational today (v6, #148): a hotel the
   * grant opens for invoices only is not one of them (its invoices are in Finance).
   */
  @PortalServiceAccess()
  @Get('hotels')
  myHotels(@Headers(PORTAL_SESSION_HEADER) token: string | undefined): Promise<PortalHotel[]> {
    return this.slots.run(async () => this.granted(await this.portalSession(token)));
  }

  /** One operational granted hotel; any other id is "not found", exactly like a missing one. */
  @PortalServiceAccess()
  @Get('hotels/:id')
  myHotel(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalHotel> {
    return this.slots.run(async () => {
      const hotel = (await this.granted(await this.portalSession(token), id))[0];
      if (!hotel) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
      return hotel;
    });
  }

  // --- "Profil hotelu" (the hotel's own profile) ------------------------------------------

  /** An operational granted hotel's own profile; any other id is "not found" (as a missing one). */
  @PortalServiceAccess()
  @Get('hotels/:id/profile')
  profile(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalHotelProfile> {
    return this.slots.run(async () => {
      const session = await this.portalSession(token);
      const allowed = (await this.grants.activeOf(session.user.id, this.db)).some((g) =>
        g.operationalHotelIds.includes(id),
      );
      const profile = allowed ? await this.hotels.portalProfile(id, this.db) : null;
      if (!profile) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
      return profile;
    });
  }

  /**
   * Saves a granted hotel's own profile (whitelisted fields only, schema-strict). The browser
   * request is checked again (the portal's origin, CSRF). Then, in ONE transaction and under the
   * account's row lock — the lock a grant revocation or a deactivation takes first — the session
   * and its active grant on THIS hotel are checked again: a revocation that committed before is
   * seen, one that comes later waits for this save. Foreign or no longer granted hotels are "not
   * found"; an ended session signs in again. The customers module writes and audits the change.
   */
  @PortalServiceAccess()
  @Post('hotels/:id/profile')
  @HttpCode(200)
  saveProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(portalHotelProfileRequestSchema)) body: PortalHotelProfileRequest,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalHotelProfile> {
    return this.slots.run(async () => {
      this.sameOrigin(body.client);
      const session = await this.portalSession(token);
      return this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${session.user.id}::uuid FOR SHARE`;
        const live = await tx.userSession.findUnique({
          where: { id: session.sessionId },
          select: {
            revokedAt: true,
            idleExpiresAt: true,
            absoluteExpiresAt: true,
            user: { select: { status: true } },
          },
        });
        if (!live) throw unauthenticated();
        if (live.user.status !== 'ACTIVE') throw accountInactive();
        const now = new Date();
        if (live.revokedAt || live.idleExpiresAt <= now || live.absoluteExpiresAt <= now)
          throw sessionExpired();
        const grant = (await this.grants.activeOf(session.user.id, tx)).find((g) =>
          g.operationalHotelIds.includes(id),
        );
        if (!grant) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
        return this.hotels.applyPortalProfile(tx, {
          hotelId: id,
          actorUserId: session.user.id,
          grantId: grant.id,
          expected: body.expected,
          profile: body.profile,
          reason: body.reason,
        });
      });
    });
  }

  // --- "Dodávky" (real orders, read only) -------------------------------------------------

  /**
   * An operational granted hotel's deliveries in three groups and its upcoming plan days; any other
   * id — also a hotel the grant opens for its invoices only, or one a fence closes — is "not
   * found" (v6: deliveries are operations).
   */
  @PortalServiceAccess()
  @Get('hotels/:id/deliveries')
  deliveriesOf(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalDeliveries> {
    return this.slots.run(async () => {
      const session = await this.portalSession(token);
      const allowed = (await this.grants.activeOf(session.user.id, this.db)).some((g) =>
        g.operationalHotelIds.includes(id),
      );
      if (!allowed) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
      // Sequential, as every portal call: at most one portal connection per request.
      const orders = await this.orders.portalDeliveries(id, this.db);
      const upcoming = await this.plans.portalUpcoming(id, this.db);
      return { ...orders, upcoming };
    });
  }

  // --- "Smlouvy" (signed originals only) -------------------------------------------------

  /**
   * An operational granted hotel's signed contracts (newest first); any other id — also a hotel the
   * grant opens for invoices only (v6) — is "not found".
   */
  @PortalServiceAccess()
  @Get('hotels/:id/contracts')
  contractsOf(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalContract[]> {
    return this.slots.run(async () => {
      const session = await this.portalSession(token);
      const allowed = (await this.grants.activeOf(session.user.id, this.db)).some((g) =>
        g.operationalHotelIds.includes(id),
      );
      if (!allowed) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
      return this.contracts.portalSigned(id, this.db);
    });
  }

  /**
   * One signed original as kept (hash checked), if its hotel is granted to the session now; any
   * other id is "not found". The download is recorded on the draft with the portal account.
   *
   * Bounded work (review 5841786998, as the Finance invoice PDF): one deadline
   * (PORTAL_CONTRACT_PDF_TIMEOUT_MS) covers reading and sending, the client leaving stops the read
   * in the storage, at most the upload limit is read, and the request slot is held until the
   * bytes have left or the connection is cut — never while storage work still runs.
   */
  @PortalServiceAccess()
  @Get('contracts/:id/pdf')
  contractPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.slots.run(async () => {
      const stop = new AbortController();
      const deadline = setTimeout(
        () => stop.abort(new Error('PortalContractPdfDeadline')),
        this.env.PORTAL_CONTRACT_PDF_TIMEOUT_MS,
      );
      const gone = () => {
        if (!res.writableFinished) stop.abort(new Error('PortalContractPdfClientGone'));
      };
      res.once('close', gone);
      try {
        const session = await this.portalSession(token);
        const hotels = new Set(
          (await this.grants.activeOf(session.user.id, this.db)).flatMap(
            (g) => g.operationalHotelIds,
          ),
        );
        const { file, signedOn } = await this.contracts.portalSignedFile(
          id,
          hotels,
          session.user.id,
          { signal: stop.signal, maxBytes: this.env.SUPPLIER_DOCUMENT_MAX_BYTES },
          this.db,
        );
        if (stop.signal.aborted) throw stop.signal.reason;
        if (res.destroyed) return;
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          res.once('finish', done);
          res.once('close', done);
          // The deadline also bounds the sending: a receiver too slow is cut off.
          stop.signal.addEventListener('abort', () => res.destroy(), { once: true });
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(file.length),
            'Content-Disposition': `attachment; filename="AYVO-smlouva-${signedOn}.pdf"`,
            'Cache-Control': 'private, no-store',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(file);
        });
      } finally {
        clearTimeout(deadline);
        res.off('close', gone);
      }
    });
  }

  // --- internals ---------------------------------------------------------------------------

  private async portalSession(token: string | undefined) {
    const session = await this.sessions.lookup(token ?? null, 'PORTAL');
    if (session.kind === 'expired') throw sessionExpired();
    if (session.kind === 'inactive') throw accountInactive();
    if (session.kind !== 'active') throw unauthenticated();
    return session;
  }

  private async granted(session: { user: { id: string } }, only?: string): Promise<PortalHotel[]> {
    const ids = new Set(
      (await this.grants.activeOf(session.user.id, this.db)).flatMap((g) => g.operationalHotelIds),
    );
    const wanted = only === undefined ? [...ids] : ids.has(only) ? [only] : [];
    return wanted.length === 0 ? [] : this.hotels.financeContractHotels(wanted, this.db);
  }

  /**
   * The forwarded browser request, before any database work: the portal's origin, the IP limit,
   * then (when the request names it) the account's or link's limit. Redis, fail closed.
   */
  private async browser(client: PortalClient, account?: string): Promise<void> {
    this.sameOrigin(client);
    this.decide(await this.limits.hit('login', `portal-ip:${client.ip}`));
    if (account) await this.accountLimit(account);
  }

  /** Separate account keys thwart distributed guessing; no raw e-mail or token is in Redis. */
  private async accountLimit(account: string): Promise<void> {
    this.decide(await this.limits.hit('callback_failure', `portal-account:${sha256Hex(account)}`));
  }

  private decide(decision: { allowed: boolean; unavailable?: boolean }): void {
    if (!decision.allowed)
      throw domainError(
        decision.unavailable ? 503 : 429,
        decision.unavailable ? 'AUTH_UNAVAILABLE' : 'RATE_LIMITED',
        'Přihlášení je dočasně omezené. Zkuste to za chvíli.',
      );
  }

  /** The browser's request came from the portal itself (the portal's own CSRF rule, §3). */
  private sameOrigin(client: PortalClient): void {
    const portal = this.env.PORTAL_PUBLIC_ORIGIN;
    if (!portal)
      throw domainError(503, 'PORTAL_NOT_CONFIGURED', 'The hotel portal is not configured');
    if (client.origin !== portal || !sameOriginRequest(client.secFetchSite, client.origin, portal))
      throw domainError(403, 'CSRF_REJECTED', 'Cross-site request refused');
  }

  private async expensive<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PasswordWorkLimitError)
        throw domainError(503, 'AUTH_UNAVAILABLE', 'Přihlášení je vytížené. Zkuste to za chvíli.');
      throw error;
    }
  }
}

/** A grant as the session view names it: the payer and all its hotels (unchanged contract). */
const scopeOf = (g: { id: string; payerCustomerId: string; hotelIds: string[] }) => ({
  id: g.id,
  payerCustomerId: g.payerCustomerId,
  hotelIds: g.hotelIds,
});
