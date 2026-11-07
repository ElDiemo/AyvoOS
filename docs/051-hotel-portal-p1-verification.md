# 051 — Hotel portal P1: verification map (what exists, what is to be built, the tests)

Status: **preparation for ADR 0045** (PR #127). Nothing in this document is implemented. It maps
the existing routes, fixtures and tests that the first walk builds on, the changes still needed,
and the exact tests to write. Written on `main` `5650409`, 2026-11-07.

## 1. Existing tests run (isolated, `ayvo-build-safe`, a throwaway test database)

Commit `6150408` is `main` `5650409` plus a test-only change in `apps/web/e2e`. Files run:

- `identity.e2e.test.ts`, `native-auth.e2e.test.ts`, `native-auth-mail.e2e.test.ts`,
  `native-bootstrap.e2e.test.ts`, `auth-rate-limit.e2e.test.ts` (identity);
- `finance-issuer-settings.e2e.test.ts`, `finance-billing-settings.e2e.test.ts`,
  `finance-run-settings.e2e.test.ts` (Finance).

**Result:** 8 files, **133 tests passed**, 0 failed (78.6 s). No DEV or PROD database and no
external call; mail uses the test transport.

## 2. What exists and is reused

| Need of P1                       | Existing route / code                                                                                                     | Existing test / fixture                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invitation, activation           | `POST /api/auth/native/activate`; invitations in `identity/users.service.ts`                                              | `native-auth.e2e`, `native-auth-mail.e2e`; `support/sign-in.ts` `prepareInvitedUser`                                                                         |
| Password + TOTP sign-in          | `POST /api/auth/native/password`, `…/mfa`, recovery codes                                                                 | `native-auth.e2e`                                                                                                                                            |
| Reset, forgot                    | `…/forgot-password`, `…/reset-password`                                                                                   | `native-auth.e2e`, `native-auth-mail.e2e`                                                                                                                    |
| Rate limits (Redis, fail closed) | `AuthRateLimitService`                                                                                                    | `auth-rate-limit.e2e` (`{ redis: 'real' }`)                                                                                                                  |
| Sessions, revocation             | `user_sessions` (idle/absolute expiry, `revoked_at`), `access.guard.ts`                                                   | `identity.e2e`; `support/sign-in.ts` `sessionCookie`                                                                                                         |
| CSRF on state-changing calls     | `access.guard.ts` (`Origin`/`Sec-Fetch-Site`); Finance → core `principal` (`finance-contract.controller.ts:59`)           | `identity.e2e`                                                                                                                                               |
| Hotels (read)                    | `hotels` (core, `customers` module), Finance reads them via `/api/internal/v1/finance/hotels`                             | `orders`/`finance-billing-settings.e2e`                                                                                                                      |
| Payers, agreements               | Finance `customers`, `billing_agreements` (versions)                                                                      | `finance-billing-settings.e2e`                                                                                                                               |
| Invoices, lines, PDF             | `GET /api/admin/finance/invoices`, `/:number`, `/:number/pdf` (`invoices.controller.ts:43–106`); `invoice_lines.hotel_id` | `finance-issuer-settings.e2e`: a separate TEST invoice, **a summary invoice of one customer**, **a hotel handed over to another payer**, never in production |
| Payment state                    | `payments.service.ts:60` (`UNPAID / PARTIALLY_PAID / PAID`)                                                               | `finance-issuer-settings.e2e` (partial, overpayment, cancelled)                                                                                              |
| Finance as its own unit          | `support/finance-app.ts` `createFinanceTestApp` (real core over HTTP, service token)                                      | all Finance e2e                                                                                                                                              |

## 3. What is still to be built (ADR 0045 §10)

| PR  | New                                                                                                                              | Not existing today                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | `users/roles/user_sessions.audience`, role-grant and invitation triggers, audience in the internal guard and Finance `principal` | No account type; `HOTEL_USER` is planned and unassignable (`users.service.ts:475`) |
| 2   | `portal_grants(+hotels)`, `identity:portal_grants_manage`, admin API and UI                                                      | No grant; hotel scopes exist but are never evaluated                               |
| 3   | `/api/internal/v1/portal/{auth/*,session,hotels}`, portal token, concurrency cap                                                 | Native auth exists only for the internal app; there is no portal contract          |
| 4   | Finance `/api/internal/v1/portal/invoices*`, `introspect-portal` on the core contract, the ADR §5 predicate                      | Finance invoice reads are staff-only (`finance:invoices_read`)                     |
| 5   | `apps/portal` (BFF, pages, `__Host-ayvo_portal`)                                                                                 | Nothing                                                                            |
| 6   | DEV host `dev-portal.ayvo.co` (Caddy site, private DNS, ACME), only after approval                                               | Nothing                                                                            |

**Fixtures to add** (all synthetic):

- `support/portal-fixtures.ts`:
  - payers A and B with agreements for H1+H2 and H3;
  - TEST invoices A1 (H1), A2 (H1+H2, summary) and B1 (H3), built with the same API calls as
    `finance-issuer-settings.e2e`;
  - `invitePortalUser(grant)`;
  - `portalSession(email)` (password + TOTP through the portal contract).
- `createPortalTestApp`: core + Finance (as `createFinanceTestApp`) and the portal BFF on random
  ports, with three distinct service tokens.

## 4. The tests to write (each committed on a real database)

1. **Two payers:**
   - user A (grant {A: H1}) lists exactly A1;
   - user B (grant {B: H3}) lists exactly B1;
   - the list totals and pages contain no other invoice.
2. **Summary invoice:**
   - A2 (H1+H2) is invisible to {A: H1}, and visible after the grant gains H2;
   - two grants {A: H1} and {A: H2} together still do not reveal A2 (one grant must cover it).
3. **A foreign PDF:**
   - B requests the detail and the PDF of A1 by its number → 404, the same as a missing number;
   - no `Cache-Control` other than `private, no-store`.
4. **Payer change:**
   - H1 moves from payer A to payer B (as the existing hand-over test);
   - the old A invoices of H1 stay visible to the A grant and never to a B grant.
5. **Revocation in a live session:**
   - A's grant is revoked between two requests: the next list, detail and PDF give 401;
   - the session row is revoked;
   - a revocation of one of two grants narrows on the next request.
6. **Internal vs hotel session:**
   - a portal session on a sample of every internal `/api/admin/*` module and on Finance staff
     routes → 401;
   - a staff session on every portal contract route → 401;
   - a role grant of `HOTEL_USER` to a staff user and the reverse → refused, also as two
     concurrent requests;
   - a portal invitation to a staff e-mail → `EMAIL_IS_STAFF`.
7. **Finance down:**
   - with the Finance app closed: "Moje hotely" answers 200 and invoices answer 503 with no
     data;
   - with the core down: every portal route 503/401, never data.
8. **Fail closed:**
   - an empty invoice line set (forced by SQL in the test DB) → not visible;
   - a TEST invoice with `APP_ENV=production` → not visible;
   - a timeout of `introspect-portal` → 503.
9. **Auth endpoints:**
   - each portal auth route is rate limited (Redis real) and fails closed without Redis;
   - a cross-origin `POST` → 403;
   - answers are alike for unknown and known accounts.

Playwright (PR 5): the ADR §11 walk on the isolated `ayvo_e2e` database at 390 px and 1440 px,
with the TOTP code computed from the enrolment secret (`otpauth`, as `native-auth.e2e`
does). There is no real mailbox; the invitation link comes
from the test mail transport.

## 5. Blockers

- **The owner's approval of ADR 0045 (PR #127)** before PR 1–4: a new model, permissions and
  contracts.
- **The DEV host and DNS (PR 6):** the owner's approval and Codex (infrastructure).
- None for writing these tests once the model is approved: all run on isolated databases.
