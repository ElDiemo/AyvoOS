# ADR 0014: Public QR identity, URL format and DEV/production separation

- **Status:** Accepted — confirmed by owner 2026-10-10 (token format, URL formats, environment
  safeguards). The **physical QR size / error correction is NOT yet approved** (see below).
- **Date:** 2026-10-10
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** — (answers the "QR payload format" open question of
  [ADR 0005](0005-permanent-bottle-identity.md))

## Context

ADR 0005 requires a permanent, opaque, practically unguessable public QR identity per bottle,
separate from the internal ID, with a URL that stays stable for the bottle's physical lifetime.
Milestone 1 prints the first labels, so the format had to be fixed — and labels printed for
testing on DEV must never be mistaken for, or encode the URLs of, production labels.

## Decision

### Token (approved)

- 128 bits from the OS CSPRNG (`crypto.randomBytes(16)`), encoded **base64url without padding**
  → exactly 22 characters `[A-Za-z0-9_-]`.
- Independent of the internal ID and of the sequential bottle code (`AYV-B-000001`, which is
  **not** a security boundary). Generated once at bottle creation; unique and pattern-checked in
  PostgreSQL; immutable (trigger); never recycled (bottles are never deleted).

### URL formats (approved)

| Environment | QR URL                          |
| ----------- | ------------------------------- |
| Production  | `https://qr.ayvo.co/<token>`    |
| DEV preview | `https://dev.ayvo.co/q/<token>` |

The QR encodes **only** this URL — no mutable bottle data. `PUBLIC_QR_BASE_URL` is configuration;
the production value is never used as a default anywhere.

### DEV / production separation (required safeguards, implemented)

1. **Startup:** a production process (`APP_ENV=production`) refuses to start unless
   `PUBLIC_QR_BASE_URL` is exactly `https://qr.ayvo.co`; a non-production process refuses to start
   if its base URL's **host** is `qr.ayvo.co` or a subdomain of it (case, port, userinfo and a
   trailing dot cannot hide it). Base URLs with credentials are rejected.
2. **Print job creation and rendering:** the same rule is checked again (HTTP 403, nothing created
   or rendered). A production process never renders a DEV job and vice versa.
3. **Database:** the CHECK `label_print_jobs_qr_environment_check` enforces the same rule per
   job (`app_environment` ↔ `public_base_url`, by parsed host via `ayvo_url_host()`); a trigger
   enforces that every label's stored QR URL is exactly the job's base URL + `/` + the token.
4. **Snapshot:** every immutable print job stores its environment, base URL, error correction
   level and the exact QR URL of each label.
5. **Visible marker:** every label rendered by a non-production job carries a red
   `DEV - NOT FOR PRODUCTION` band (drawn under the QR code, never covering it).
6. **Previews:** the designer and template previews use the API's configured preview URL and EC
   level; no frontend constant, default or fallback contains a production URL.
7. Automated tests cover every refusal case (`apps/api/src/config/env.test.ts`,
   `src/common/qr-policy.test.ts`, `test/qr-environment.e2e.test.ts`,
   `test/database-invariants.e2e.test.ts`) and the web previews (Playwright).

Production labels must not be printed until DNS and routing for `qr.ayvo.co/<token>` work.

**Accepted security trade-off — the production domain is code, not configuration.** The value
`https://qr.ayvo.co` exists only in the central policy (`apps/api/src/common/qr-policy.ts`), the
matching database CHECK, their tests and documentation. Changing the production QR domain is
therefore an **intentional code change plus a database migration** (and the old host must keep
resolving printed labels). This is deliberate: no configuration mistake can make a non-production
system print production URLs, or production print anything else.

### Physical QR parameters — PROVISIONAL (not approved)

Current production **candidate**: **15 mm** total box (quiet zone included), error correction
**Q**, solid black on an opaque white square. Configurable via `LABEL_QR_MIN_SIZE_MM` and
`LABEL_QR_ERROR_CORRECTION`; production refuses to start without both being set explicitly.
Non-production defaults: EC Q, minimum 10 mm (so smaller variants can be tested).

Approval requires a physical test of the validation sheet
(`GET /api/admin/label-calibration/qr-validation-sheet.pdf`: 10/12/15/18 mm × EC M/Q, production
URL length via the reserved host `qr.invalid`):

| Condition                                  | Result |
| ------------------------------------------ | ------ |
| Immediately after printing                 | open   |
| On the actual curved bottle                | open   |
| Warehouse lighting / hotel lighting        | open   |
| Wet                                        | open   |
| After repeated washing (number of cycles?) | open   |
| Modern and older phones / scanners         | open   |

**Approved combination: — (to be recorded here after the test).**

## Consequences

### Positive

- Enumeration is infeasible; DEV prints can never be confused with or collide with production.
- Every label ever printed can be traced to its exact URL and environment.

### Negative

- `qr.ayvo.co` must be operated for the bottles' whole physical lifetime.
- Production label printing is blocked until the physical test, the printer details and the
  `qr.ayvo.co` routing are done.

## Alternatives considered

- **Sequential code in the QR** — rejected: enumerable (ADR 0005).
- **UUIDv4 token** — 36 characters, denser QR, no gain.
- **Signed tokens (HMAC of the ID)** — requires key management forever.

## Open questions

- Approved QR size and error correction (physical test above).
- Relabelling of damaged labels (ADR 0005 open question).
