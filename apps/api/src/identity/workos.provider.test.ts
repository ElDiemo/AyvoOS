import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { IdentityVerificationError } from './identity-provider.js';
import { WorkOsIdentityProvider } from './workos.provider.js';

const API_KEY = 'sk_test_secret_value_never_printed';
const config = {
  apiKey: API_KEY,
  clientId: 'client_test_123',
  apiBaseUrl: 'https://api.workos.example',
  issuer: null,
};

let jwk: JWK;
let sign: (
  claims: Record<string, unknown>,
  opts?: { expired?: boolean; foreignKey?: boolean },
) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 3600 : '5m')
      .sign(opts.foreignKey ? other.privateKey : privateKey);
});

function provider(response: { status?: number; body?: unknown }, seen: { body?: string } = {}) {
  return new WorkOsIdentityProvider(config, {
    jwks: createLocalJWKSet({ keys: [jwk] }),
    fetch: (async (_url: unknown, init?: RequestInit) => {
      seen.body = String(init?.body);
      return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
    }) as typeof fetch,
  });
}

const user = { id: 'user_01', email: 'Operator@Ayvo.Example', email_verified: true };

describe('WorkOS identity provider (ADR 0022)', () => {
  it('builds the AuthKit authorization URL with state and PKCE (S256)', () => {
    const url = new URL(
      provider({}).authorizationUrl({
        state: 'state-1',
        codeChallenge: 'challenge-1',
        redirectUri: 'https://dev.ayvo.example/api/auth/callback',
        loginHint: 'a@b.example',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://api.workos.example/user_management/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client_test_123',
      redirect_uri: 'https://dev.ayvo.example/api/auth/callback',
      response_type: 'code',
      provider: 'authkit',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      login_hint: 'a@b.example',
    });
    expect(url.toString()).not.toContain(API_KEY);
  });

  it('exchanges the code server-side and returns the verified identity', async () => {
    const seen: { body?: string } = {};
    const token = await sign({ sub: 'user_01', sid: 'session_01' });
    const identity = await provider({ body: { user, access_token: token } }, seen).exchangeCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
    });
    expect(identity).toEqual({
      provider: 'WORKOS',
      subject: 'user_01',
      email: 'operator@ayvo.example',
      emailVerified: true,
      providerSessionId: 'session_01',
    });
    expect(JSON.parse(seen.body!)).toMatchObject({
      client_id: 'client_test_123',
      client_secret: API_KEY,
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'verifier-1',
    });
  });

  it.each([
    ['a token of another user', { sub: 'user_02' }, {}],
    ['an expired token', { sub: 'user_01' }, { expired: true }],
    ['a token signed by a foreign key', { sub: 'user_01' }, { foreignKey: true }],
  ])('refuses %s', async (_name, claims, opts) => {
    const token = await sign(claims, opts);
    await expect(
      provider({ body: { user, access_token: token } }).exchangeCode({
        code: 'c',
        codeVerifier: 'v',
      }),
    ).rejects.toBeInstanceOf(IdentityVerificationError);
  });

  it('refuses a configured issuer mismatch', async () => {
    const strict = new WorkOsIdentityProvider(
      { ...config, issuer: 'https://api.workos.example' },
      {
        jwks: createLocalJWKSet({ keys: [jwk] }),
        fetch: (async () =>
          new Response(
            JSON.stringify({
              user,
              access_token: await sign({ sub: 'user_01', iss: 'https://evil.example' }),
            }),
          )) as typeof fetch,
      },
    );
    await expect(strict.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toBeInstanceOf(
      IdentityVerificationError,
    );
  });

  it('reports provider failures without secrets or tokens', async () => {
    for (const response of [
      { status: 401, body: { error: 'invalid_grant', echo: API_KEY } },
      { body: { user } },
      { body: { user, access_token: 'not-a-jwt' } },
    ]) {
      const error = await provider(response)
        .exchangeCode({ code: 'c', codeVerifier: 'v' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdentityVerificationError);
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain('not-a-jwt');
    }
  });

  it('builds a provider logout URL only when the provider session is known', () => {
    const p = provider({});
    expect(
      p.logoutUrl({ providerSessionId: null, returnTo: 'https://x.example/login' }),
    ).toBeNull();
    const url = new URL(
      p.logoutUrl({ providerSessionId: 'session_01', returnTo: 'https://x.example/login' })!,
    );
    expect(url.pathname).toBe('/user_management/sessions/logout');
    expect(url.searchParams.get('session_id')).toBe('session_01');
  });
});
