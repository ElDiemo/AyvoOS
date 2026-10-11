import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  IdentityVerificationError,
  type ExternalIdentity,
  type IdentityProvider,
} from './identity-provider.js';

export interface WorkOsConfig {
  apiKey: string;
  clientId: string;
  apiBaseUrl: string;
  /** Expected `iss` of access tokens; when null only signature, expiry and subject are checked. */
  issuer: string | null;
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
        ...(this.config.issuer ? { issuer: this.config.issuer } : {}),
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch {
      throw new IdentityVerificationError('The access token could not be verified');
    }
    if (claims.sub !== userId) {
      throw new IdentityVerificationError('The access token belongs to another user');
    }
    return {
      provider: 'WORKOS',
      subject: userId,
      email: email.trim().toLowerCase(),
      emailVerified: body.user?.email_verified === true,
      providerSessionId: typeof claims.sid === 'string' ? claims.sid : null,
    };
  }

  logoutUrl(input: { providerSessionId: string | null; returnTo: string }): string | null {
    if (!input.providerSessionId) return null;
    const url = new URL('/user_management/sessions/logout', this.config.apiBaseUrl);
    url.searchParams.set('session_id', input.providerSessionId);
    url.searchParams.set('return_to', input.returnTo);
    return url.toString();
  }
}
