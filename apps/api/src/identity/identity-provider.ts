/**
 * Provider boundary (ADR 0022): everything AYVO needs from an external OIDC identity provider.
 * Business code references AYVO users only, so the provider can be replaced without touching it.
 */
export interface ExternalIdentity {
  /** "WORKOS" or "TEST" — stored with the identity link. */
  provider: 'WORKOS' | 'TEST';
  /** The provider's stable user id (verified by the provider adapter). */
  subject: string;
  email: string;
  emailVerified: boolean;
  /** The provider's own session id, for provider logout. Not a credential. */
  providerSessionId: string | null;
}

export interface IdentityProvider {
  readonly name: ExternalIdentity['provider'];
  /** Where the browser goes to sign in. */
  authorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint?: string;
  }): string;
  /**
   * Exchanges the one-time code server-to-server and returns the VERIFIED identity. Throws on
   * any failure; never returns unverified claims.
   */
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ExternalIdentity>;
  /** Provider logout URL that ends the provider session, or null (the AYVO session is enough). */
  logoutUrl(input: { providerSessionId: string | null; returnTo: string }): string | null;

  // --- invitations (doc 021 §7b); server-side only, the API key never leaves the server -------

  /** Sends a registration invitation to the e-mail. */
  sendInvitation(input: { email: string; expiresInDays: number }): Promise<ProviderInvitation>;
  getInvitation(id: string): Promise<ProviderInvitation>;
  /** Pending invitations of the e-mail (reconciles a send whose response was lost). */
  findPendingInvitations(email: string): Promise<ProviderInvitation[]>;
  /** Sends a pending invitation's e-mail again. */
  resendInvitation(id: string): Promise<ProviderInvitation>;
  revokeInvitation(id: string): Promise<ProviderInvitation>;
}

/** The provider's view of an invitation. Never contains its token or acceptance link. */
export interface ProviderInvitation {
  id: string;
  email: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: Date;
  /** The provider user who accepted it (accepted only). */
  acceptedUserId: string | null;
}

/**
 * A provider call failed; the message is safe to log and show (no secrets, no tokens).
 * `ambiguous`: the provider may have done it (no answer — timeout, network); the caller must
 * reconcile before retrying instead of assuming failure.
 */
export class IdentityProviderError extends Error {
  constructor(
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

/** Thrown when an identity cannot be verified; the message is safe to log (no secrets). */
export class IdentityVerificationError extends Error {}
