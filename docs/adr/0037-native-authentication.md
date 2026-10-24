# ADR 0037: Native password + TOTP authentication inside AYVO OS

- **Status:** Proposed — owner decision 2026-10-23/24 (replace WorkOS); implementation in review,
  not deployed. Accepted only after the owner's activation on DEV and the same commit on PROD.
- **Date:** 2026-10-24
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes:** the provider part of [ADR 0022](0022-external-oidc-authentication.md) (WorkOS
  AuthKit). Authorization, sessions, roles, scopes and audit of ADR 0022 / doc 021 stay unchanged.
- **Operations:** [doc 038](../038-native-authentication.md); scope and gates:
  [native-authentication-work.md](../native-authentication-work.md).

## Context

The owner could not complete a first sign-in through the external provider on production, and
decided that AYVO OS signs users in itself: e-mail + password, then a code from an authenticator
app. No new identity vendor, public registration, passwordless flow, SSO or production-only code.
The existing Google Workspace is only the outgoing mail transport for invitations and password
resets (no Google sign-in).

## Decision

1. **Factors.** Password (Argon2id m=64 MiB t=3 p=1, bounded concurrency, dummy hash for unknown
   accounts) and TOTP (RFC 6238, SHA-1/6 digits/30 s, ±1 step) — both always. Ten one-time
   recovery codes (128 bit, stored as purpose-bound SHA-256) replace the TOTP code, never the
   password. A full `ayvo_session` exists only after both factors, also during first activation
   and password reset; a reset never removes MFA and ends with a fresh sign-in.
2. **Secrets at rest.** TOTP seeds and queued mail links: AES-256-GCM with
   `AUTH_ENCRYPTION_KEY` (per environment, never copied, refused if not random), bound to user
   and purpose. Link tokens (256 bit) and challenges are stored only as hashes. Sent, used,
   revoked or expired material is removed (`purgeExpired`).
3. **State in PostgreSQL** (additive migration `20261027090000_native_authentication`):
   `native_credentials` (revisions; a trigger forbids deletion, rewinding the TOTP step and
   credential changes without the next revision), `native_auth_tokens` (ENROLL / RESET_PASSWORD),
   `native_auth_challenges` (browser-bound by the HttpOnly `ayvo_auth` cookie, 5 attempts,
   5–15 min), `native_recovery_codes`. Replay and races are decided under a row lock on the user.
4. **Onboarding only by invitation** (the existing invitation administration, provider `LOCAL`):
   a one-time link → own password → authenticator QR → code → recovery codes. The bootstrap ADMIN
   is activated once by `identity:activate-bootstrap` (refuses anyone else; reports the real
   delivery state). Deactivation, revocation and resend take effect immediately.
5. **Mail is a transport, chosen explicitly** (`AUTH_MAIL_DRIVER`): `google-relay` — the approved
   Google Workspace SMTP relay authorising AYVO's public IPv4 addresses (host/port fixed in code,
   STARTTLS + certificate verification required, IPv4-only socket, no credentials) — or `smtp`
   with user and password. Never a fallback between them; `memory` only with `APP_ENV=test`.
6. **Unchanged:** session cookie and lifetimes, same-origin CSRF check, per-request permission
   evaluation, Redis rate limits that fail closed, `AUTH_PROVIDER=test` only in automated tests.
   WorkOS runtime code and keys are removed; historical WorkOS identities, invitations and audit
   stay as data.

## Consequences

- AYVO owns password and MFA security (hash parameters, key backup, mail deliverability). The
  per-environment key must be backed up off the server before the first activation: without it
  enrolled accounts cannot sign in and the application has no reset for them (doc 038 §2).
- Existing users activate natively once through a new invitation; nothing is exported from WorkOS.
- **Rollback** is an application rollback to the previous release, never a database restore
  (doc 038 §6): the migration is additive and the previous release ignores the new tables.
- WorkOS configuration and secrets are removed only after production acceptance (gate 7 of the
  work document).
