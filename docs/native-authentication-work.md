# Native AYVO authentication — owner decision, 2026-10-23

Status: implementation in progress on `codex/native-auth`; not reviewed, merged or deployed.
Baseline: `db8640a46b22dfdd05f66e922f0e03308c1f8d0b`.

Handoff status, 2026-10-24: uncommitted work in progress, NOT a reviewed release. The branch now
contains local password/TOTP primitives, additive schema/migration, API enrollment/login/reset/
MFA replacement, local invitation and SMTP outbox services, a restricted existing-bootstrap
activation CLI, Czech web forms, and preliminary deployment/configuration changes. WorkOS runtime
adapter files are removed in this branch, not in the deployed application. Historical identity
records are retained. The same application is intended for DEV and PROD.

Actual verification so far: the first isolated database/API run passed 12 of 13 integration
tests plus 10 primitive unit tests. The remaining test used an invalid expiry fixture; its
fixture was corrected but a successful rerun has NOT been established. A later wider run lost
its SSH database tunnel and must not be counted as a valid green run. API build and earlier
API/web type checks passed; final lint, builds, complete tests and independent review remain.
The migration ran ONLY on the dedicated disposable test PostgreSQL, never on preview or PROD.

The native browser runner/configuration exist, but their actual browser spec is still missing.
Legacy browser fixture helpers still expect the old login page and require adaptation without
weakening authorization assertions. Deployment script tests still need migration to native
configuration. Outbox expiry cleanup and bootstrap delivery reporting need review. Documentation
and an ADR must be completed, as must integration with current main (including employee cards).

The owner identified existing Google Workspace (G Suite) as the email provider. This authorizes
no new service or Google identity integration. Actual SMTP configuration/credentials are NOT
prepared. Never use memory mail, test encryption keys, fake users or MFA bypass on DEV/PROD.
No native-auth PR, CI result, independent review, merge or deployment exists yet.

## Agreed outcome

Replace WorkOS with authentication inside the existing AYVO API and web application. No new
identity vendor, separate identity application, public registration, passwordless flow, SSO or
production-only fork. Normal sign-in is one email/password form followed by one authenticator
code form. Existing users, roles, site scopes, authorization, audit and business data remain.

Invitation/first setup happens once: open the emailed AYVO link, choose a password, scan the
authenticator QR, confirm a code and save recovery codes. No visit to a vendor dashboard.
Password reset never removes the second factor. No full session exists before both factors
succeed, including first setup. Logout and deactivation revoke access locally.

## External-dependency decision rule

An external service is not the default. Before introducing one, present the owner with the
actual need, an in-house alternative, maintenance/security responsibilities, price, availability
and data dependencies, and an exit strategy. Obtain a joint decision before connecting it.
This does not mean inventing cryptographic algorithms: reviewed open-source libraries run in
AYVO's own process, without sending credentials to a service. SMTP is a delivery transport,
not an identity provider; choose/configure an existing approved mail transport separately and
never silently buy or connect a new service.

## Implementation boundaries

- Passwords: Argon2id, random salt, bounded work/concurrency; never plaintext or fast hashes.
- MFA: standard TOTP through a library, encrypted secret with separate environment-owned key,
  atomic replay prevention, one-use high-entropy recovery codes stored only as hashes.
- Short-lived, browser-bound preauthentication; server-side attempt limits and expiry.
- Single-use, purpose-bound, expiring invitation/reset tokens stored as hashes. Delivery is
  retryable; no token/password/TOTP seed in logs or administrative responses.
- Generic public failure/reset answers; rate limits by IP and account, fail closed if unavailable.
- Existing secure HTTP-only session cookie and same-origin CSRF protection remain.
- Recovery/re-enrollment cannot silently bypass MFA, reactivate users or grant permissions.
- No exporting passwords or MFA secrets from WorkOS. Existing AYVO users perform a fresh native
  activation. Retain historical identities/audit; no deletion/recreation of business users.
- Additive migrations; historical migrations unchanged. Document application rollback
  compatibility and activation order. Never wipe a database to change authentication.
- Update API, web, invitation administration, test fixtures, deployment preflight/environment
  validation and documentation together. Remove runtime WorkOS calls and required keys.
- Tests use synthetic accounts and actual password/MFA verification; no DEV/PROD bypass.

## Delivery gates

1. Cryptographic primitives, storage and concurrency tests.
2. Native login/enrollment/recovery/invitations and simple Czech screens; remove WorkOS wiring.
3. API/database/browser regressions: incomplete MFA, replay/races, expiry, token purpose,
   deactivation during login, stale challenges after password change, CSRF, limits and failures.
4. Independent review and green CI on exact head; standard DEV deployment only after approval.
5. Owner completes real first activation/login/logout/recovery on DEV.
6. Promote that exact tested commit to PROD, prepare independent PROD activation and mail/key
   configuration; never copy DEV accounts, tokens, secrets or database to PROD.
7. Remove obsolete WorkOS configuration only after successful production acceptance. Never revoke
   the current provider or existing access while the replacement is incomplete.

Security references:
[password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html),
[password recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
