# ADR 0039: Finance as its own runtime unit (limited variant A)

- **Status:** Proposed — implementation in PR #67/#68. The **boundary** was approved by the owner
  on 2026-10-25 ("Ano, takto omezenou variantu A"; FINANCE-UNIT-DECISION-20261025). Everything
  marked _to measure_ or _decision_ below is not approved. ADR 0038 (PR #65) stays Proposed; this
  ADR does **not** depend on its steps P1–P5 (workers, Sales, identity are not moved).
- **Date:** 2026-10-25
- **Scope:** Finance N1 (received documents) and N2 (export for the accountant), doc 039. Not
  invoicing, banking, payroll or a ledger.

## 1. Approved boundary (owner, 2026-10-25)

- Finance runs in **its own container**, with **its own database schema and DB login role**, and
  is **deployed and rolled back on its own**.
- Suppliers, supplier documents and the **current** user, permissions and site scopes come from
  the existing OS **through a secured interface** — never by reading its tables.
- Sales, the background workers and sign-in stay where they are; no new identity system.
- A Finance crash must not take the OS down; while the OS is down, the Finance operations that
  need it are **temporarily unavailable** (fail closed). The host and the PostgreSQL cluster
  stay shared, named failure domains.
- Variant B (Finance inside the core process) was **not** chosen.

## 2. Runtime

| Part              | Decision                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process           | Service `finance` in Compose (DEV and PROD the same), entry point `node dist/finance/main.js`: a Nest app with **only** the Finance module, its own Prisma client, the core client of §4 and FileStorage. It does not load the core modules, the workers or identity.                                       |
| Image and version | The API image (same build), but its **own release tag** (`FINANCE_RELEASE`): `deploy-*.sh --finance` builds, migrates the `finance` schema and replaces only the `finance` container; rollback starts the previous tag. A Finance release never rebuilds or restarts `api`/`web`/workers.                   |
| Routing           | The internal Caddy sends `/api/admin/finance/*` to `finance:4010`, everything else unchanged. No public route (tailnet only, like the rest of the OS).                                                                                                                                                      |
| Health            | `/api/admin/finance/health/live` = the process answers (Compose healthcheck); `/api/admin/finance/health/ready` = its DB and the core contract answer. A live but not ready Finance answers `503 FINANCE_DEPENDENCY_UNAVAILABLE` to operations needing the core.                                           |
| Limits            | _To measure on DEV before PROD_: memory 512 MiB, 0.5 CPU, pool 4 / role `CONNECTION LIMIT 5`. PROD has 4 GiB in total; the current services' real use is measured first and the budget is set against it (§7).                                                                                            |

## 3. Data — what is really enforced, and what is not yet

**Today (measured in the repository config):** `api` and `web` connect as `POSTGRES_USER`, which
the official PostgreSQL image creates as a **superuser**. A superuser ignores `GRANT`/`REVOKE`, so
the core can read and write any schema. A Finance role alone therefore gives **one-sided**
isolation.

| Direction          | What this ADR implements                                                                                                                                                                                                                                                          | Enforced by                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Finance → core     | Login role `ayvo_finance`: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, owner of schema `finance` only, no grant on any `public` object (`REVOKE ALL ON ALL TABLES IN SCHEMA public`, default privileges unchanged). Its own migration history (`finance._prisma_migrations`). | PostgreSQL (tested as the role) |
| Core → Finance     | No core code references `finance.*` (test on the core sources).                                                                                                                                                                                                                   | **Convention only** — see below |
| Cross-unit links   | No foreign keys between `finance` and `public`: supplier, supplier document, site and user are plain ids + the snapshot Finance needs (names as of the event).                                                                                                                       | Schema                          |

**Blocker for two-sided isolation (decision):** the core must stop connecting as the superuser:
a new `ayvo_core` login role (non-superuser) with grants on `public`, `api`/`web` switched to it,
the superuser kept only for migrations and backups. This touches every core deploy and the
secrets of DEV and PROD, so it is **not** done hidden inside the Finance PR. Proposed as its own
small PR after this one, or accepted as a named residual risk.

Migrations: `finance` has its own Prisma schema and migrations folder, applied by
`deploy-*.sh --finance` (as the superuser, only `migrate deploy` of that folder; creates the role
if missing — its password comes from the server env `FINANCE_DB_PASSWORD`, never Git).

## 4. Contracts with the core (the only way Finance gets OS data)

**Service authentication.** Every call from Finance carries `Authorization: Bearer
<FINANCE_SERVICE_TOKEN>` (32 random bytes, server env of both containers, rotated by redeploying
both). The core compares its SHA-256 in constant time, accepts it **only** on `/internal/v1/*`,
and the audience of that token is `finance`: it may call only the routes below. A private Docker
network is **not** treated as authentication. The core's public edge never forwards
`/internal/*` (Caddy: abort).

**User on behalf of whom Finance acts.** The browser sends its `ayvo_session` cookie to Finance
(same origin). Finance never decodes it and never trusts a user id from the request: for every
request it calls

`POST /internal/v1/finance/principal` `{ sessionToken, method, origin, secFetchSite }`

The core resolves the session exactly as its own guard does (idle/absolute expiry, revocation,
deactivation, current roles, permissions and site scopes — evaluated now, no cache), applies the
same CSRF rule to the forwarded method/origin, and returns `{ userId, displayName, permissions,
globalSiteAccess, siteIds }` or `401/403`. Finance then checks its own route permission
(`finance:*`). An `actorId` is therefore always the core's answer for this request; a forged one
is impossible without a valid session **and** the service token.

**Data calls** (each with the service token **and** the session token; the core re-checks the
user's permissions/site for that call):

| Call                                              | Core checks                                                    |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `GET  /internal/v1/finance/suppliers`             | `finance:documents_manage`                                     |
| `GET  /internal/v1/finance/suppliers/:id`         | `finance:documents_read`; returns active + identity snapshot   |
| `GET  /internal/v1/finance/supplier-documents`    | `procurement:documents_read` on each listed site               |
| `GET  /internal/v1/finance/supplier-documents/:id[/content]` | the same, for that document's site — every call, also on replay |

Timeouts: 2 s (content 30 s), at most one retry for GETs; no retries for anything else.
Unavailable/timeout → Finance answers `503 FINANCE_DEPENDENCY_UNAVAILABLE`, never a guess. The
supplier "active" check moves from a row lock inside one transaction to a check-then-write; a
supplier archived in between is accepted as a known, documented race (archiving affects new
receipts, not historical paperwork).

## 5. UI and what stays shared (decision)

The Finance pages stay in the existing Next app (`apps/web`, same origin), calling
`/api/admin/finance/*`, which now reaches the Finance container. Consequences, stated plainly:

- A Finance **API** release is independent; a Finance **UI** change still needs a `web` release.
- The `web` process is shared: a web outage hides Finance pages too (Finance itself keeps
  running); a Finance outage shows "Finance je dočasně nedostupné" in its pages only.
- A separate Finance web app would remove this sharing but is a larger change (new app, build,
  edge route). Not done hidden; offered as a follow-up decision.

## 6. Failure behaviour (to be proven in an isolated test topology, never on live DEV/PROD)

| Failure                    | OS                    | Finance                                                                 |
| -------------------------- | --------------------- | ----------------------------------------------------------------------- |
| Finance crashes / OOM      | unaffected            | restarts alone; uploads/exports idempotent per request id               |
| Core API down              | down                  | live, not ready: every request 503 (no principal = fail closed)          |
| Identity data says revoked | —                     | the very next request refused                                           |
| Export too large / busy    | unaffected            | refused before loading files; one export build at a time per process   |
| PostgreSQL / host down     | down                  | down (shared, named)                                                    |

## 7. Budgets — proposals to measure, not evidence

Memory, CPU and the connection numbers in §2 are starting points. Before PROD: measure `api`,
`web`, workers, Postgres, Caddy, qr-edge on DEV under the usual load; check the sum against the
4 GiB of PROD with headroom; then fix the Finance limits. An export holds at most the originals
(≤ 100 MiB) plus one archive copy at a time.

## 8. Reuse of the written code

N1/N2 services, contracts, UI, tests and the ZIP writer stay. Changes: the Finance Prisma
schema and migrations move to `apps/api/prisma-finance/` (schema `finance`, no cross FKs,
snapshots); `ProcurementService` calls become the core client of §4; the core gets the
`/internal/v1/finance/*` controller and the service-token guard; `main.ts` for Finance;
Compose service, Caddy route and `--finance` deploy step. The review findings F-R2–F-R6 are fixed
in the same PRs.

## 9. Decisions still open

1. §3 blocker: switch the core to a non-superuser role (own PR) — or accept one-sided isolation
   as a named risk until then.
2. §5: Finance UI inside the shared web app (proposed) vs. a separate Finance web app.
3. §7 budgets after measurement.
