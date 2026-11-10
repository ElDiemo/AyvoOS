# 064 — Public hotel portal (portal.ayvo.co): topology and runbook (proposal for review)

Status: **proposal**, nothing implemented. No PROD, DNS, account or invitation change comes from
this document. Each step marked _approval_ needs the owner's explicit approval; PROD and DNS are
carried out by Codex from the reviewed plan (CLAUDE.md, Workflow). Builds on ADR 0045 (§6–§8),
doc 036 (PROD), doc 052 (DEV portal) and the overlays for ID (`compose.id.yml`) and marketing
(`compose.marketing.yml`, ADR 0040).

Verified starting point (2026-11-10, read only): the public A record of `portal.ayvo.co` points to
the PROD host; `deploy/prod` and `scripts/deploy-prod.sh` have no portal runtime.

## 1. The one constraint: a single public :443

On PROD the only listener on the public IPv4 :443 is `qr-edge` (QR, optionally ID and marketing).
ADR 0045 §7 asks for a separate `portal-edge` whose network reaches only `portal-web`. A second
process cannot bind the same public IPv4 :443. Three options:

| Option              | What                                                                                                                                                              | Isolation                                                                               | Cost / risk                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **A (recommended)** | The portal site is one more site of the existing public edge, added by an overlay exactly like ID and marketing; the edge reaches `portal-web` on its own network | The edge process is shared (as for QR/ID/marketing); every network boundary below holds | Smallest change; needs an ADR 0045 §7 amendment         |
| B                   | A separate `portal-edge` on a second public IPv4                                                                                                                  | As ADR 0045 says                                                                        | A second address at the provider, a second ACME path    |
| C                   | `portal-edge` takes :443 and passes QR/ID/marketing on                                                                                                            | Strongest for the portal                                                                | Rebuilds the proven QR/ID/marketing edge — out of scope |

_Approval:_ the owner chooses; A comes with an ADR amendment ("one public edge process, one site
and one network per public service").

## 2. Topology (option A)

```
internet ─443/IPv4─▶ qr-edge ──(portal-edge network)──▶ portal-web
                       │                                  │
                       ├─(public)─▶ web  (QR/ID only)      └─(portal-contracts network)─▶ api:4000    /api/internal/v1/portal/*
                       └─(marketing)─▶ marketing                                         ─▶ finance:4010 /api/internal/v1/portal/invoices*
CA ─80─▶ caddy ─(acme network, challenge path only)─▶ qr-edge:80      (portal certificate, HTTP-01)
tailnet ─443─▶ caddy (os.ayvo.co, staff) — unchanged, never reachable from the portal host
```

- **`deploy/prod/compose.portal.yml`** — added by `deploy-prod.sh` only when `PORTAL_DOMAIN` is set
  in `prod.env` (like `ID_DOMAIN` / `MARKETING_DOMAIN`); without it nothing below exists.
- **One `portal-web`** — the reviewed image, read-only root, unprivileged, `no-new-privileges`, all
  capabilities dropped, 256 MB / 0.5 CPU / 128 pids (ADR 0045 §8), no published port, no egress
  network (internal networks only), `APP_ENV=production`, `PORTAL_PUBLIC_ORIGIN=https://portal.ayvo.co`.
- **Networks** (all `internal: true` except where noted):
  - `portal-edge`: `qr-edge` ↔ `portal-web` only.
  - `portal-contracts`: `portal-web` ↔ `api`, `finance` only. Never `postgres`, `redis`, `web`,
    `caddy`.
  - `qr-edge` stays off `backend`: it cannot reach `api`, `finance` or the databases.
- **Edge site** (`deploy/prod/sites/portal.caddy`, mounted like marketing's): the DEV rules of
  doc 052 unchanged — `/api` and `/api/*` abort (also `/api/internal*`); GET/HEAD to portal-web;
  POST only on the auth routes and on exactly `/hotels/<uuid>/profile`; request bodies 4 KiB
  (8 KiB for the profile save), the same read timeouts against slow/trickled bodies; `-Server`,
  `-X-Powered-By`; `X-Forwarded-For` from the edge only (`PORTAL_TRUST_PROXY=1`); any other host
  aborts. The tailnet guard of DEV becomes the public site, nothing else changes.
- **Certificate**: `deploy/prod/acme.d/portal.caddy` lets the internal `caddy` pass only
  `/.well-known/acme-challenge/*` for `portal.ayvo.co` to `qr-edge:80` (the ID/marketing pattern).
- **Secrets** (`/opt/ayvo/secrets/prod.env`, never git, never shared with DEV, generated on the
  PROD host): `PORTAL_CORE_TOKEN`, `PORTAL_FINANCE_TOKEN` (43–128 URL-safe chars, different from
  each other and from `FINANCE_SERVICE_TOKEN`); the core gets only `PORTAL_SERVICE_TOKEN_SHA256`,
  Finance only `PORTAL_FINANCE_TOKEN_SHA256`; `deploy-prod.sh --check` verifies lengths, hashes and
  difference (as `deploy-dev.sh` does on DEV) and never prints them.
- **Limits kept**: core portal pool 2 / 8 in flight, Finance portal pool 1 / 2 in flight, PDF 20 s /
  10 MB, the shared ZIP ceiling (40 MiB / 60 s), `max_connections` checked by `--check`.
- **Unchanged**: `os.ayvo.co` stays tailnet only; QR, ID and marketing sites and their behaviour;
  `/api/internal/*` stays unreachable from every public and staff site.

## 3. Release order (each step its own approval)

1. **#148 boundary implemented, reviewed and accepted on DEV** — operational data only for
   `OPERATIONS` hotels; a former payer keeps its own invoices only. Then #149 → #170.
2. **This topology on DEV** (§5), then the code PR: `compose.portal.yml`, `sites/portal.caddy`,
   `acme.d/portal.caddy`, `deploy-prod.sh` (`PORTAL_DOMAIN`, the token checks, `--portal` /
   `--portal-rollback` with the exact image tested on DEV, never built on PROD — the marketing
   pattern), a static repository test like `apps/marketing`'s for the overlay and the site rules.
3. _Approval_ — Codex: `deploy-prod.sh --check`, then the portal unit with `PORTAL_DOMAIN` set, no
   account exists yet. Verification (§4). The DNS record already points at the host; the site
   answers only once the overlay is deployed.
4. _Approval_ — first real accounts only by the owner's decision, through the Finance payer page;
   no invitation before that.

## 4. Verifying the isolation (PROD after step 3; the same commands on DEV)

From outside (public internet, no session):

- `https://portal.ayvo.co/login` 200 with the portal's CSP and nonce; `/api/health`,
  `/api/internal/v1/portal/session`, `/api/admin/hotels` → connection aborted; `/` → `/login`.
- `os.ayvo.co` over the public address (SNI) → refused, as today; QR/ID/marketing unchanged
  (their existing checks).
- A 5 KiB POST to `/auth/login` → refused at the edge; a POST to any other path → refused.

From the host (read only, `docker exec`):

- `qr-edge` cannot open `api:4000`, `finance:4010`, `postgres:5432`, `redis:6379`.
- `portal-web` cannot open `postgres:5432`, `redis:6379`, `web:3000`, `caddy:443` or any
  external address; it can open `api:4000` and `finance:4010` only.
- The core refuses the portal token on `/api/internal/v1/finance/*` (401) and the Finance token on
  the portal routes (existing tests, plus one live check with an invalid token — no secret used).

## 5. The same topology on DEV first — with a second payer

On DEV the portal already runs behind the tailnet Caddy (doc 052). Before the PROD code PR, the
DEV stack gets the same overlay shape (portal network reaching only `portal-web`, contracts network
to `api`/`finance` only) and the checks of §4, tailnet-only, so the PROD files are a copy of a
tested shape. Walk with synthetic data only (`PORTAL_WEB_WALK`-style real units on DEV, or an
already approved synthetic session):

- **Payer A** (current payer of hotel H, contract and invoices) — A's account sees H's profile,
  contracts, deliveries and A's invoices, ZIP and PDF.
- **Payer B** (former payer of H: H moved to A; B keeps its own past invoices of H) — B's account
  sees **its own invoices of H** (list, PDF, ZIP), and gets 404 for H's profile, contracts and
  deliveries (needs #148); never A's invoices.
- A foreign hotel 404; Finance down → Faktury unavailable, Moje hotely still works; the portal
  container stopped → the internal OS and Finance unaffected.

## 6. Disabling the portal

- **Fast**: Codex stops only `portal-web` (`docker compose … stop portal-web` with the portal
  overlay); the edge site then answers 502 for the portal host only; the OS, QR, ID, marketing are
  untouched. Sessions are invalidated by revoking the PORTAL sessions in the core if needed.
- **Complete**: blank `PORTAL_DOMAIN` in `prod.env` and redeploy; the overlay, its networks and the
  edge site disappear; tokens are then rotated before any re-enable.
- **Rollback of a release**: `deploy-prod.sh --portal-rollback <release>` starts the previous
  portal image (no migration in the portal unit).

## 7. Open questions for the owner

1. Option A (shared public edge process, ADR amendment) or B (second public IPv4)?
2. Should `portal.ayvo.co` be reachable before the first account exists (login page only), or
   only after the first invitation decision?
3. Rename the internal cookie to `__Host-ayvo_session` (ADR 0045 §7 recommendation) before the
   public portal?
