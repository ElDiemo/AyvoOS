import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  IdentityProviderError,
  IdentityVerificationError,
  type ExternalIdentity,
  type IdentityProvider,
  type ProviderInvitation,
} from './identity-provider.js';

export interface WorkOsConfig {
  apiKey: string;
  clientId: string;
  apiBaseUrl: string;
  /** Exact expected `iss` of access tokens (configuration only — never read from a token). */
  issuer: string;
}

/** WorkOS signs AuthKit access tokens with RS256; no other algorithm is accepted. */
const ACCEPTED_ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 30;
const USER_SUBJECT = /^user_[A-Za-z0-9]{10,}$/;

/**
 * Checks that a signature-verified token is a human AuthKit user session of this application:
 * exact client, user subject, session id, numeric issue/expiry times, an audience (when present)
 * of this client, and no delegation, agent or machine-to-machine markers. Fails closed: anything
 * missing or malformed is refused.
 */
export function assertUserSessionClaims(
  claims: Record<string, unknown>,
  expected: { clientId: string; userId: string },
): void {
  const refuse = (why: string): never => {
    throw new IdentityVerificationError(`The access token is not a user session: ${why}`);
  };
  if (claims.client_id !== expected.clientId) refuse('foreign or missing client');
  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (audiences.length === 0 || audiences.some((a) => a !== expected.clientId)) {
      refuse('foreign audience');
    }
  }
  if (typeof claims.sub !== 'string' || !USER_SUBJECT.test(claims.sub))
    refuse('not a user subject');
  if (claims.sub !== expected.userId) refuse('another user');
  if (typeof claims.sid !== 'string' || claims.sid.length === 0) refuse('missing session id');
  for (const claim of ['iat', 'exp'] as const) {
    const value = claims[claim];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      refuse(`missing or malformed ${claim}`);
    }
  }
  if ((claims.iat as number) >= (claims.exp as number)) refuse('inverted lifetime');
  if ((claims.iat as number) > Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS) {
    refuse('issued in the future');
  }
  // Delegation (impersonation `act`), agent and machine-to-machine profiles are not human sign-ins.
  for (const marker of ['act', 'may_act', 'gty', 'agent', 'agent_id']) {
    if (claims[marker] !== undefined) refuse('delegated, agent or machine token');
  }
  if (claims.grant_type !== undefined && claims.grant_type !== 'authorization_code') {
    refuse('machine grant');
  }
}

interface AuthenticateResponse {
  user?: { id?: unknown; email?: unknown; email_verified?: unknown };
  access_token?: unknown;
}

/**
 * WorkOS AuthKit adapter (ADR 0022). Sign-in happens on WorkOS; the authorization code is
 * exchanged server-to-server with the API key, and the returned access token is verified against
 * the client-specific JWKS before anything is trusted. The API key and tokens are never logged or
 * put into error messages.
 */
export class WorkOsIdentityProvider implements IdentityProvider {
  readonly name = 'WORKOS' as const;
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    private readonly config: WorkOsConfig,
    options: { jwks?: JWTVerifyGetKey; fetch?: typeof fetch } = {},
  ) {
    this.jwks =
      options.jwks ??
      createRemoteJWKSet(
        new URL(`/sso/jwks/${encodeURIComponent(config.clientId)}`, config.apiBaseUrl),
      );
    this.fetchImpl = options.fetch ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint?: string;
  }): string {
    const url = new URL('/user_management/authorize', this.config.apiBaseUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('provider', 'authkit');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<ExternalIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL('/user_management/authenticate', this.config.apiBaseUrl),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_id: this.config.clientId,
            client_secret: this.config.apiKey,
            grant_type: 'authorization_code',
            code: input.code,
            code_verifier: input.codeVerifier,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new IdentityVerificationError('The identity provider could not be reached');
    }
    if (!response.ok) {
      throw new IdentityVerificationError(
        `The identity provider refused the code (HTTP ${response.status})`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as AuthenticateResponse;
    const userId = body.user?.id;
    const email = body.user?.email;
    const token = body.access_token;
    if (typeof userId !== 'string' || typeof email !== 'string' || typeof token !== 'string') {
      throw new IdentityVerificationError('The identity provider returned an incomplete response');
    }

    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        algorithms: ACCEPTED_ALGORITHMS,
        requiredClaims: ['iss', 'sub', 'sid', 'iat', 'exp', 'client_id'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch {
      throw new IdentityVerificationError('The access token could not be verified');
    }
    assertUserSessionClaims(claims, { clientId: this.config.clientId, userId });
    return {
      provider: 'WORKOS',
      subject: userId,
      email: email.trim().toLowerCase(),
      emailVerified: body.user?.email_verified === true,
      providerSessionId: claims.sid as string,
    };
  }

  // --- invitations (User Management API; the API key is sent server-to-server only) ----------

  async sendInvitation(input: {
    email: string;
    expiresInDays: number;
  }): Promise<ProviderInvitation> {
    return toInvitation(
      await this.call('POST', '/user_management/invitations', {
        email: input.email,
        expires_in_days: input.expiresInDays,
      }),
    );
  }

  async getInvitation(id: string): Promise<ProviderInvitation> {
    return toInvitation(
      await this.call('GET', `/user_management/invitations/${encodeURIComponent(id)}`),
    );
  }

  async findPendingInvitations(email: string): Promise<ProviderInvitation[]> {
    const body = (await this.call(
      'GET',
      `/user_management/invitations?email=${encodeURIComponent(email)}&limit=100`,
    )) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new IdentityProviderError('The identity provider returned an unexpected list');
    }
    return body.data.map(toInvitation).filter((i) => i.state === 'pending' && i.email === email);
  }

  async resendInvitation(id: string): Promise<ProviderInvitation> {
    return toInvitation(
      await this.call('POST', `/user_management/invitations/${encodeURIComponent(id)}/resend`, {}),
    );
  }

  async revokeInvitation(id: string): Promise<ProviderInvitation> {
    return toInvitation(
      await this.call('POST', `/user_management/invitations/${encodeURIComponent(id)}/revoke`, {}),
    );
  }

  /** One API call; failures carry only the method, path kind and HTTP status (no body, no key). */
  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.apiBaseUrl), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new IdentityProviderError('The identity provider could not be reached', true);
    }
    if (!response.ok) {
      // 5xx may have been processed; 4xx was refused.
      throw new IdentityProviderError(
        `The identity provider refused the invitation request (HTTP ${response.status})`,
        response.status >= 500,
      );
    }
    return response.json().catch(() => {
      throw new IdentityProviderError('The identity provider returned an unreadable response');
    });
  }

  logoutUrl(input: { providerSessionId: string | null; returnTo: string }): string | null {
    if (!input.providerSessionId) return null;
    const url = new URL('/user_management/sessions/logout', this.config.apiBaseUrl);
    url.searchParams.set('session_id', input.providerSessionId);
    url.searchParams.set('return_to', input.returnTo);
    return url.toString();
  }
}

const INVITATION_STATES = ['pending', 'accepted', 'expired', 'revoked'] as const;

/** Only the fields AYVO keeps — the invitation token and acceptance URL are dropped here. */
function toInvitation(raw: unknown): ProviderInvitation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const state = INVITATION_STATES.find((x) => x === r.state);
  const expiresAt = typeof r.expires_at === 'string' ? new Date(r.expires_at) : null;
  if (
    typeof r.id !== 'string' ||
    typeof r.email !== 'string' ||
    !state ||
    !expiresAt ||
    Number.isNaN(expiresAt.getTime())
  ) {
    throw new IdentityProviderError('The identity provider returned an incomplete invitation');
  }
  return {
    id: r.id,
    email: r.email.trim().toLowerCase(),
    state,
    expiresAt,
    acceptedUserId: typeof r.accepted_user_id === 'string' ? r.accepted_user_id : null,
  };
}
