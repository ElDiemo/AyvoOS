import { randomToken } from './crypto.js';
import { randomUUID } from 'node:crypto';
import {
  IdentityProviderError,
  IdentityVerificationError,
  type ExternalIdentity,
  type IdentityProvider,
  type ProviderInvitation,
} from './identity-provider.js';

/**
 * Fake identity provider for automated tests ONLY. The environment schema refuses
 * AUTH_PROVIDER=test unless APP_ENV=test, and the authorize endpoint answers 404 otherwise, so
 * this can never be an authentication bypass on DEV or production. The "signed-in" identity is
 * the login hint (an e-mail); codes are one-time and short-lived, like real ones.
 *
 * Invitations are kept in memory. Signing in with an e-mail that has a pending invitation
 * "registers through it" (the invitation becomes accepted by that subject), like following the
 * invitation link at the real provider. Test-only e-mail markers simulate provider behaviour:
 * `+fail` (sending fails), `+lost` (the first send succeeds but its response is lost), `+expired`
 * (sent already expired), `+mismatch` (accepted by another provider user).
 */
export class TestIdentityProvider implements IdentityProvider {
  readonly name = 'TEST' as const;
  private readonly codes = new Map<string, { email: string; expiresAt: number }>();
  private readonly invitations = new Map<string, ProviderInvitation>();
  private readonly lost = new Set<string>();

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
    const normalized = email.trim().toLowerCase();
    this.codes.set(code, { email: normalized, expiresAt: Date.now() + 60_000 });
    // Registering through a pending invitation accepts it.
    for (const invitation of this.invitations.values()) {
      if (invitation.email === normalized && this.view(invitation).state === 'pending') {
        invitation.state = 'accepted';
        invitation.acceptedUserId = normalized.includes('+mismatch')
          ? 'test|someone-else@ayvo.test'
          : `test|${normalized}`;
      }
    }
    return code;
  }

  async sendInvitation(input: {
    email: string;
    expiresInDays: number;
  }): Promise<ProviderInvitation> {
    if (input.email.includes('+fail')) {
      throw new IdentityProviderError(
        'The identity provider refused the invitation request (HTTP 422)',
      );
    }
    const invitation: ProviderInvitation = {
      id: `invitation_${randomUUID()}`,
      email: input.email,
      state: 'pending',
      expiresAt: new Date(
        input.email.includes('+expired')
          ? Date.now() - 60_000
          : Date.now() + input.expiresInDays * 86_400_000,
      ),
      acceptedUserId: null,
    };
    this.invitations.set(invitation.id, invitation);
    if (input.email.includes('+lost') && !this.lost.has(input.email)) {
      this.lost.add(input.email);
      throw new IdentityProviderError('The identity provider could not be reached', true);
    }
    return this.view(invitation);
  }

  async getInvitation(id: string): Promise<ProviderInvitation> {
    const invitation = this.invitations.get(id);
    if (!invitation)
      throw new IdentityProviderError(
        'The identity provider refused the invitation request (HTTP 404)',
      );
    return this.view(invitation);
  }

  async findPendingInvitations(email: string): Promise<ProviderInvitation[]> {
    return [...this.invitations.values()]
      .map((i) => this.view(i))
      .filter((i) => i.email === email && i.state === 'pending');
  }

  async resendInvitation(id: string): Promise<ProviderInvitation> {
    const invitation = await this.getInvitation(id);
    if (invitation.state !== 'pending') {
      throw new IdentityProviderError(
        'The identity provider refused the invitation request (HTTP 400)',
      );
    }
    return invitation;
  }

  async revokeInvitation(id: string): Promise<ProviderInvitation> {
    const invitation = this.invitations.get(id);
    if (!invitation || this.view(invitation).state !== 'pending') {
      throw new IdentityProviderError(
        'The identity provider refused the invitation request (HTTP 400)',
      );
    }
    invitation.state = 'revoked';
    return this.view(invitation);
  }

  /** The invitation as the provider reports it (pending past its expiry reads as expired). */
  private view(invitation: ProviderInvitation): ProviderInvitation {
    const expired = invitation.state === 'pending' && invitation.expiresAt.getTime() <= Date.now();
    return { ...invitation, state: expired ? 'expired' : invitation.state };
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
