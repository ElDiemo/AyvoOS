import { randomToken } from './crypto.js';
import {
  IdentityVerificationError,
  type ExternalIdentity,
  type IdentityProvider,
} from './identity-provider.js';

/**
 * Fake identity provider for automated tests ONLY. The environment schema refuses
 * AUTH_PROVIDER=test unless APP_ENV=test, and the authorize endpoint answers 404 otherwise, so
 * this can never be an authentication bypass on DEV or production. The "signed-in" identity is
 * the login hint (an e-mail); codes are one-time and short-lived, like real ones.
 */
export class TestIdentityProvider implements IdentityProvider {
  readonly name = 'TEST' as const;
  private readonly codes = new Map<string, { email: string; expiresAt: number }>();

  constructor(private readonly apiOrigin: string) {}

  authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint?: string;
  }): string {
    const url = new URL('/api/auth/test-provider/authorize', this.apiOrigin);
    url.searchParams.set('state', input.state);
    url.searchParams.set('redirect_uri', input.redirectUri);
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
    return url.toString();
  }

  /** The fake provider's "sign-in": issue a one-time code for the hinted e-mail. */
  issueCode(email: string): string {
    const code = randomToken();
    this.codes.set(code, { email: email.trim().toLowerCase(), expiresAt: Date.now() + 60_000 });
    return code;
  }

  async exchangeCode(input: { code: string }): Promise<ExternalIdentity> {
    const entry = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new IdentityVerificationError('Unknown or expired code');
    }
    return {
      provider: 'TEST',
      subject: `test|${entry.email}`,
      email: entry.email,
      emailVerified: true,
      providerSessionId: null,
    };
  }

  logoutUrl(): string | null {
    return null;
  }
}
