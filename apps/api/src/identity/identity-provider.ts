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
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

/** Thrown when an identity cannot be verified; the message is safe to log (no secrets). */
export class IdentityVerificationError extends Error {}
