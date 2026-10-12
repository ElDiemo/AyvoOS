import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { IdentityProviderError, IdentityVerificationError } from './identity-provider.js';
import { WorkOsIdentityProvider } from './workos.provider.js';

const API_KEY = 'sk_test_secret_value_never_printed';
const config = {
  apiKey: API_KEY,
  clientId: 'client_test_123',
  apiBaseUrl: 'https://api.workos.example',
  issuer: 'https://auth.workos.example',
};
const USER_ID = 'user_01HZXAMPLE0000000000000001';
const OTHER_USER_ID = 'user_01HZXAMPLE0000000000000002';
/** Claims of a genuine AuthKit user session token of this client. */
const session = (extra: Record<string, unknown> = {}) => ({
  iss: config.issuer,
  sub: USER_ID,
  sid: 'session_01HZXAMPLE',
  client_id: config.clientId,
  ...extra,
});

let jwk: JWK;
let sign: (
  claims: Record<string, unknown>,
  opts?: { expired?: boolean; foreignKey?: boolean; rawTimes?: boolean; alg?: 'HS256' },
) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  sign = (claims, opts = {}) => {
    if (opts.alg === 'HS256') {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough-123'));
    }
    const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' });
    // rawTimes: the test sets (or deliberately omits/malforms) iat and exp itself.
    if (!opts.rawTimes) {
      jwt
        .setIssuedAt(opts.expired ? Math.floor(Date.now() / 1000) - 7200 : undefined)
        .setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 3600 : '5m');
    }
    return jwt.sign(opts.foreignKey ? other.privateKey : privateKey);
  };
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

const user = { id: USER_ID, email: 'Operator@Ayvo.Example', email_verified: true };

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
    const token = await sign(session());
    const identity = await provider({ body: { user, access_token: token } }, seen).exchangeCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
    });
    expect(identity).toEqual({
      provider: 'WORKOS',
      subject: USER_ID,
      email: 'operator@ayvo.example',
      emailVerified: true,
      providerSessionId: 'session_01HZXAMPLE',
    });
    expect(JSON.parse(seen.body!)).toMatchObject({
      client_id: 'client_test_123',
      client_secret: API_KEY,
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'verifier-1',
    });
  });

  const now = () => Math.floor(Date.now() / 1000);
  it.each<[string, Record<string, unknown>, Parameters<typeof sign>[1]]>([
    ['a token of another user', session({ sub: OTHER_USER_ID }), {}],
    ['an expired token', session(), { expired: true }],
    ['a token signed by a foreign key', session(), { foreignKey: true }],
    ['a symmetric (HS256) token', session(), { alg: 'HS256' }],
    ['a valid signature with a wrong issuer', session({ iss: 'https://evil.example' }), {}],
    ['a valid signature with no issuer', session({ iss: undefined }), {}],
    ['an issuer that differs only by a trailing slash', session({ iss: `${config.issuer}/` }), {}],
    ['a valid signature with a wrong client id', session({ client_id: 'client_other_0001' }), {}],
    ['a valid signature with no client id', session({ client_id: undefined }), {}],
    ['a foreign audience', session({ aud: 'https://another-api.example' }), {}],
    ['an audience list with a foreign entry', session({ aud: [config.clientId, 'x'] }), {}],
    ['an empty audience list', session({ aud: [] }), {}],
    ['a missing sid', session({ sid: undefined }), {}],
    ['an empty sid', session({ sid: '' }), {}],
    ['a missing exp', session({ iat: now() }), { rawTimes: true }],
    ['a missing iat', session({ exp: now() + 300 }), { rawTimes: true }],
    ['a string exp', session({ iat: now(), exp: String(now() + 300) }), { rawTimes: true }],
    ['a fractional iat', session({ iat: now() + 0.5, exp: now() + 300 }), { rawTimes: true }],
    ['an iat in the future', session({ iat: now() + 3600, exp: now() + 7200 }), { rawTimes: true }],
    ['iat after exp', session({ iat: now() + 10, exp: now() + 5 }), { rawTimes: true }],
    [
      'a machine-to-machine token (client subject, no sid)',
      {
        iss: config.issuer,
        sub: config.clientId,
        client_id: config.clientId,
        aud: config.clientId,
      },
      {},
    ],
    ['an impersonation (act) token', session({ act: { sub: 'admin@workos' } }), {}],
    ['an agent token', session({ agent_id: 'agent_01' }), {}],
    ['a client-credentials token', session({ gty: 'client-credentials' }), {}],
  ])('refuses %s', async (_name, claims, opts) => {
    const token = await sign(claims, opts);
    await expect(
      provider({ body: { user, access_token: token } }).exchangeCode({
        code: 'c',
        codeVerifier: 'v',
      }),
    ).rejects.toBeInstanceOf(IdentityVerificationError);
  });

  it('accepts an audience of this client when one is present', async () => {
    for (const aud of [config.clientId, [config.clientId]]) {
      const token = await sign(session({ aud }));
      await expect(
        provider({ body: { user, access_token: token } }).exchangeCode({
          code: 'c',
          codeVerifier: 'v',
        }),
      ).resolves.toMatchObject({ subject: USER_ID });
    }
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

  describe('invitations (server-side User Management API)', () => {
    const raw = {
      object: 'invitation',
      id: 'invitation_01',
      email: 'New@Ayvo.Example',
      state: 'pending',
      expires_at: '2026-10-19T10:00:00.000Z',
      accepted_user_id: null,
      token: 'secret-invitation-token',
      accept_invitation_url: 'https://auth.example/invite?token=secret-invitation-token',
    };
    const calls: { url: string; init?: RequestInit }[] = [];
    const invitations = (status = 200, body: unknown = raw) =>
      new WorkOsIdentityProvider(config, {
        jwks: createLocalJWKSet({ keys: [jwk] }),
        fetch: (async (url: unknown, init?: RequestInit) => {
          calls.push({ url: String(url), init });
          return new Response(JSON.stringify(body), { status });
        }) as typeof fetch,
      });

    it('sends with the API key as a bearer header and keeps neither token nor link', async () => {
      calls.length = 0;
      const sent = await invitations().sendInvitation({
        email: 'new@ayvo.example',
        expiresInDays: 7,
      });
      expect(sent).toEqual({
        id: 'invitation_01',
        email: 'new@ayvo.example',
        state: 'pending',
        expiresAt: new Date('2026-10-19T10:00:00.000Z'),
        acceptedUserId: null,
      });
      expect(JSON.stringify(sent)).not.toContain('secret-invitation-token');
      expect(calls[0]!.url).toBe('https://api.workos.example/user_management/invitations');
      expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${API_KEY}`,
      );
      expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
        email: 'new@ayvo.example',
        expires_in_days: 7,
      });
    });

    it('lists only pending invitations of exactly that e-mail', async () => {
      const list = invitations(200, {
        data: [
          raw,
          { ...raw, id: 'invitation_02', state: 'revoked' },
          { ...raw, id: 'i3', email: 'x@y.z' },
        ],
      });
      expect((await list.findPendingInvitations('new@ayvo.example')).map((i) => i.id)).toEqual([
        'invitation_01',
      ]);
    });

    it('resends, revokes and reads by id (path-encoded)', async () => {
      calls.length = 0;
      const p = invitations();
      await p.resendInvitation('invitation_01');
      await p.revokeInvitation('a/b');
      await p.getInvitation('invitation_01');
      expect(calls.map((c) => `${c.init!.method} ${new URL(c.url).pathname}`)).toEqual([
        'POST /user_management/invitations/invitation_01/resend',
        'POST /user_management/invitations/a%2Fb/revoke',
        'GET /user_management/invitations/invitation_01',
      ]);
    });

    it('classifies failures: refused (4xx) vs. ambiguous (5xx, no answer); no secrets in errors', async () => {
      const refused = await invitations(422, { message: API_KEY })
        .sendInvitation({ email: 'a@b.c', expiresInDays: 7 })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(IdentityProviderError);
      expect((refused as IdentityProviderError).ambiguous).toBe(false);
      expect((refused as Error).message).not.toContain(API_KEY);
      const unsure = await invitations(503)
        .sendInvitation({ email: 'a@b.c', expiresInDays: 7 })
        .catch((e: unknown) => e);
      expect((unsure as IdentityProviderError).ambiguous).toBe(true);
      const offline = new WorkOsIdentityProvider(config, {
        jwks: createLocalJWKSet({ keys: [jwk] }),
        fetch: (async () => {
          throw new Error(`socket hang up ${API_KEY}`);
        }) as typeof fetch,
      });
      const lost = await offline.getInvitation('x').catch((e: unknown) => e);
      expect((lost as IdentityProviderError).ambiguous).toBe(true);
      expect((lost as Error).message).not.toContain(API_KEY);
      const broken = await invitations(200, { id: 'x' })
        .getInvitation('x')
        .catch((e: unknown) => e);
      expect(broken).toBeInstanceOf(IdentityProviderError);
    });
  });
});
