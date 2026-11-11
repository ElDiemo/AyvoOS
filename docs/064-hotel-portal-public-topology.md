# 064 — Public hotel portal (portal.ayvo.co): topology and runbook (proposal for review)

Status: **proposal**, nothing implemented on PROD. No PROD, DNS, account or invitation change
comes from this document, and no endpoint or network is added to the live PROD during
preparation. Each step marked _approval_ needs the owner's explicit approval. Roles (the owner's
rules, 2026-11-11): Claude implements, watches CI, merges and carries out the authorized
deployments — PROD and DNS included, each only after that step's explicit approval, from this
reviewed plan with its checks and rollback; Codex verifies independently (review, the checks of
§4 from outside). Green CI, the independent verification and the owner's approval stay separate
conditions. Builds on ADR 0045 (§6–§8),
doc 036 (PROD), doc 052 (DEV portal) and the overlays for ID (`compose.id.yml`) and marketing
(`compose.marketing.yml`, ADR 0040). Review 5847937038 recommends option A; this revision answers
its three points.

Verified starting point (2026-11-10, read only): the public A record of `portal.ayvo.co` points to
the PROD host; `deploy/prod` and `scripts/deploy-prod.sh` have no portal runtime.

## 1. Topology: option A — the existing public Caddy, a separate portal-web

On PROD the only listener on the public IPv4 :443 is `qr-edge` (QR, optionally ID and marketing).
A second process cannot bind it, so the portal becomes one more site of that Caddy, added by an
overlay exactly like ID and marketing, and `portal-web` stays its own, separately deployable unit.
The shared public Caddy is an explicit shared failure domain (ADR amendment, §8).

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
- **One `portal-web`** — the image tested on DEV (loaded by ID, never built on PROD — the
  marketing pattern), read-only root, unprivileged, `no-new-privileges`, all capabilities
  dropped, 256 MB / 0.5 CPU / 128 pids (ADR 0045 §8), no published port, internal networks only,
  `APP_ENV=production`, `PORTAL_PUBLIC_ORIGIN=https://portal.ayvo.co`.
- **Networks** (internal): `portal-edge` = `qr-edge` ↔ `portal-web` only; `portal-contracts` =
  `portal-web` ↔ `api`, `finance` only — never `postgres`, `redis`, `web`, `caddy`. `qr-edge` stays
  off `backend` and cannot reach `api`, `finance` or the databases.
- **Edge site** (`deploy/prod/sites/portal.caddy`): the DEV rules of doc 052 — `/api` and `/api/*`
  abort; GET/HEAD to portal-web; POST only on the auth routes and on exactly
  `/hotels/<uuid>/profile`; bodies 4 KiB (8 KiB for the profile save) with the same read timeouts;
  `-Server`, `-X-Powered-By`; `X-Forwarded-For` from the edge only; any other host aborts.
- **Certificate**: `deploy/prod/acme.d/portal.caddy` passes only
  `/.well-known/acme-challenge/*` for `portal.ayvo.co` to `qr-edge:80` (the ID/marketing pattern).
- **Unchanged**: the global `servers` options of the public Caddy (`write 30s` etc.), the QR, ID
  and marketing sites, `os.ayvo.co` tailnet only, `/api/internal/*` unreachable from every site.

## 2. The ZIP and the public Caddy's 30 s write limit (review point 1)

The public Caddy sets `timeouts { write 30s }` for its whole :443 server; the portal's ZIP may take
up to 60 s at Finance (65 s at portal-web). An isolated test (Appendix A) on `caddy:2-alpine`
(2.11.7, the PROD image) and `caddy:2.11.9-alpine` shows that **a write limit scoped to the portal
host is not possible on the shared listener**:

- with the server's `write` kept, a route's `timeouts { write_timeout … }` cannot extend it — a slow
  download is cut at the server limit on every host, the portal's package route included;
- without the server's `write`, a route's `write_timeout` does not bound a streamed response's
  total time — QR/ID/marketing would lose their limit. Rejected.

Options (_approval_):

|                      | What                                                                                                                                                                                                                                                                                                                    | QR/ID/marketing                           | Portal ZIP                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| **A1 (recommended)** | Keep `write 30s` untouched; the public portal's package stays within it: Finance `FINANCE_PORTAL_PACKAGE_TIMEOUT_MS` and `…_MAX_BYTES` set lower on PROD (allowed — only ever lower than the shared ceiling), portal-web's package deadline from a new `PORTAL_PACKAGE_DEADLINE_MS` (≤ the edge's write minus a margin) | unchanged (static test of `Caddyfile.qr`) | ZIP ≤ 16 MiB within 20 s end to end; beyond that "Zvolte kratší období" |
| A2                   | Raise the server `write` to 70 s                                                                                                                                                                                                                                                                                        | changed — excluded by the review          | full 40 MiB / 60 s                                                      |
| B                    | Second public IPv4, its own portal edge with `write 70s`                                                                                                                                                                                                                                                                | unchanged                                 | full 40 MiB / 60 s                                                      |

Proof for A1 before the ADR amendment: a real ZIP at the public ceiling through the public Caddy
configuration with the client throttled to 8 Mbit/s completes; one above the ceiling is refused
before sending (the existing 422); a static test asserts the `servers` block of `Caddyfile.qr` is
unchanged.

**DEV acceptance (review 5858165597, #178 `portal-a1-acceptance.e2e.test.ts`, DEV server,
2026-11-11).** The real core, Finance and built portal-web (test DB, synthetic payer invited and
activated through the portal with memory mail — no DEV preview data, account or mail) behind a
real Caddy 2.11.9 with `Caddyfile.qr`'s global options verbatim and `sites/portal.caddy` (only
`tls internal` instead of ACME); Finance's limits and portal-web's deadline read from the rendered
PROD Compose; 60 TEST invoices filling the cap; curl at 1 000 000 B/s (8 Mbit/s); every PDF in the
ZIP byte-identical to the issued one, the manifest complete.

| Package               | Built (first byte) | Whole at 8 Mbit/s | Result                                                     |
| --------------------- | ------------------ | ----------------- | ---------------------------------------------------------- |
| 16 MiB (16 731 587 B) | 0.13 s             | 17.0–17.7 s       | within Finance 20 s, portal-web 25 s, edge 30 s — accepted |
| 20 MiB (20 925 887 B) | 0.16 s             | 20.5–21.7 s       | past Finance's 20 s, through only by buffering — rejected  |

Finance's deadline lasts until its last byte has left; so the PROD cap is **16 MiB**
(`FINANCE_PORTAL_PACKAGE_MAX_BYTES=16777216`, ADR 0047 §3), not 20.

## 3. Release order (review point 2) — private first, public last, fully reversible

1. **#148** implemented, independently reviewed, merged and accepted on DEV (second payer, §5).
2. **Private contracts on PROD** (_approval_; Claude carries it out, Codex verifies):
   - generate on the PROD host `PORTAL_CORE_TOKEN` and `PORTAL_FINANCE_TOKEN` (43–128 URL-safe
     chars, different from each other and from `FINANCE_SERVICE_TOKEN`; never DEV's);
   - set in the core `PORTAL_PUBLIC_ORIGIN=https://portal.ayvo.co` and
     `PORTAL_SERVICE_TOKEN_SHA256`, in Finance `PORTAL_FINANCE_TOKEN_SHA256`; `deploy-prod.sh
--check` verifies format, hashes and difference without printing them;
   - deploy core and Finance: the contracts accept the portal tokens, but nothing public reaches
     them (no portal-web, no edge site; Caddy aborts `/api/internal/*`).
3. **Private portal-web** (_approval_): `deploy-prod.sh --portal` with the DEV-tested image, on its
   internal networks only, **no edge site yet**. Verify from the host (§4): the contracts answer,
   the tokens are not interchangeable (§7), isolation holds.
4. **Rollback rehearsal**: `--portal-rollback` to the previous image and back; core and Finance
   unaffected.
5. **Public switch** (_approval_): set `PORTAL_DOMAIN`, deploy the edge site and ACME snippet. The
   login page is public after this green acceptance (§4 from outside) — **before** any real
   invitation; invitations are a separate decision (step 6).
6. **First real invitations** (_approval_, owner) through the Finance payer page.

**Complete disable** (reverse order, each step verified):

1. remove the edge site (`PORTAL_DOMAIN` blank, redeploy) — the host stops answering;
2. stop and remove portal-web (the overlay is gone);
3. remove `PORTAL_PUBLIC_ORIGIN`, `PORTAL_SERVICE_TOKEN_SHA256` and `PORTAL_FINANCE_TOKEN_SHA256`,
   redeploy core and Finance — their portal contracts refuse every call;
4. revoke the PORTAL sessions in the core; rotate the tokens before any re-enable.

**Fast stop** (incident): stop only portal-web; the portal host answers the edge's own 503,
everything else is untouched; then the complete disable if needed.

**Fails closed** (review 5858165597 P1, automatic in `deploy-prod.sh`): with `PORTAL_PUBLIC=on` a
portal that fails its private or public check (or never becomes healthy) is not left open — it
goes back to the image that was the verified public portal when the run began (verified again),
otherwise only portal-web is stopped and the closed route is checked (the edge's 503); then the OS
sign-in (tailnet), QR, ID and marketing are checked again; `portal.log` records RESTORED or
CLOSED and the run fails. An OS deployment with `PORTAL_PUBLIC=on` first stops a running
portal-web that was never verified as public, and verifies a verified one again behind the new
edge (closing it if that fails).

### Commands (implementation in #178, all on the PROD host, each step approved)

| Step               | Command / change                                                                                                                                                                                                                                                 | Check                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Private contracts  | `prod.env`: `PORTAL_DOMAIN`, `PORTAL_CORE_TOKEN`, `PORTAL_FINANCE_TOKEN`, `PORTAL_SERVICE_TOKEN_SHA256`, `PORTAL_FINANCE_TOKEN_SHA256` (no `PORTAL_PUBLIC`); `deploy-prod.sh --check --release <commit>`, then the OS release and `--finance --release <commit>` | `--check` validates all five without printing them                                                                              |
| DEV archive        | on DEV, of the accepted tag: `docker save ayvo-dev-preview/portal-web:<tag> \| gzip -n > portal-web-<tag>.tar.gz`, `sha256sum` of the file and `docker image inspect --format '{{.Id}}'` of the tag — the two values go into the approval                        | one image, one tag (`<revision12>-<UTC time>`)                                                                                  |
| Private portal-web | `deploy-prod.sh --portal --image-archive <file> --expect-image sha256:<id> --expect-archive sha256:<file hash>`                                                                                                                                                  | from inside portal-web: `/login` 200; `api`, `finance` reachable; `postgres`, `redis`, `web`, `caddy` not; `portal.log` SUCCESS |
| Rollback rehearsal | `deploy-prod.sh --portal-rollback <revision12>-<image12>` and back                                                                                                                                                                                               | same checks                                                                                                                     |
| Public switch      | `PORTAL_PUBLIC=on`, OS release (prepares the edge), then `--portal …` again                                                                                                                                                                                      | valid HTTPS, `/login` 200 with nonce CSP, `/api*` aborted, PUT 405, the OS host 421                                             |
| Fast stop          | `deploy-prod.sh --portal-stop`                                                                                                                                                                                                                                   | portal host 503; OS, QR, ID, marketing unchanged                                                                                |
| Complete disable   | `PORTAL_PUBLIC` blank → OS release; `--portal-stop`; portal keys removed → OS and Finance releases                                                                                                                                                               | the contracts refuse every call                                                                                                 |

## 4. Verifying the isolation (PROD from step 3; the same on DEV)

From outside (no session): `https://portal.ayvo.co/login` 200 with the portal's CSP and nonce;
`/api/health`, `/api/internal/v1/portal/session`, `/api/admin/hotels` aborted; `os.ayvo.co` by SNI
refused; QR/ID/marketing unchanged (their existing checks); a 5 KiB POST to `/auth/login` refused;
POST elsewhere refused.

From the host (read only, `docker exec`): `qr-edge` cannot open `api:4000`, `finance:4010`,
`postgres:5432`, `redis:6379`; `portal-web` reaches only `api:4000` and `finance:4010` (not
`postgres`, `redis`, `web`, `caddy`, nor any external address).

## 5. The same topology on DEV first — with a second payer

On DEV the portal already runs behind the tailnet Caddy (doc 052). Before the PROD code PR the
DEV stack gets the same network shape and the checks of §4, tailnet only. Walk with synthetic data
(real units, `PORTAL_WEB_WALK`-style, or an already approved synthetic session):

- **Payer A** (current payer of hotel H) — H's profile, contracts, deliveries; A's invoices, PDF,
  ZIP.
- **Payer B** (former payer of H) — **its own invoices of H** (list, PDF, ZIP); 404 for H's
  profile, contracts and deliveries (needs #148); never A's invoices.
- A foreign hotel 404; Finance down → Faktury unavailable, Moje hotely works; portal-web stopped →
  the internal OS and Finance unaffected.

## 6. Cookies and sessions (review point 3)

- The staff cookie keeps its name `ayvo_session` for now. It is host-only (no `Domain`), so
  `portal.ayvo.co` never receives it — checked by `apps/api/src/identity/cookies.test.ts`.
- The portal cookie is `__Host-ayvo_portal` (host-only by its prefix; `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`).
- A foreign session is refused on both sides: a PORTAL session is no session on the internal OS,
  its API or its internal contract; a STAFF session is none on the portal side
  (`account-audience.e2e.test.ts`).
- Renaming to `__Host-ayvo_session` is postponed (a separate decision).

## 7. Isolated verification for this revision (no DEV build, no PROD)

- `apps/api/test/portal-token-separation.e2e.test.ts`: three **valid** synthetic tokens; each
  passes only its own receiver's service check (then only lacks a session:
  `401 UNAUTHENTICATED`); every other valid token is `401 SERVICE_UNAUTHENTICATED` — on the core's
  portal contract, Finance's portal invoices and the core's Finance contract. 1/1.
- `apps/api/src/identity/cookies.test.ts`: the staff cookie is host-only. 2/2.
- Appendix A (Caddy, scaled 10×): the results of §2.

## 8. Implementation proposal (for review; after #148 and the owner's choice in §2)

1. ADR 0045 amendment: one public Caddy process, one site and one internal network per public
   service; the shared failure domain named; the ZIP bound of §2.
2. `deploy/prod/compose.portal.yml`, `sites/portal.caddy`, `acme.d/portal.caddy`.
3. `scripts/deploy-prod.sh`: `PORTAL_DOMAIN`, the token and origin checks, `--portal` /
   `--portal-rollback` with an image archive tested on DEV and its expected ID.
4. A static repository test (like `prod-id-edge.test.ts`): the overlay's networks, the site's
   rules, `Caddyfile.qr` unchanged, no route from the portal host to `web`, `api` or `finance`.
5. For A1: `PORTAL_PACKAGE_DEADLINE_MS` in portal-web (≤ the shared ceiling), PROD values for
   Finance's package limits, and the throttled-client test of §2.
6. DEV first: the same shape on DEV (doc 052 amendment), then PROD per §3.

## 9. Decisions for the owner

1. ~~A1 or B~~ — decided: A1 (owner, review 5848102779); its cap is 16 MiB after the DEV
   acceptance (§2).
2. The ADR 0045 amendment for option A.

## Appendix A — the isolated Caddy test

A slow upstream sends 6 × 1 KiB, one per second. A Caddy with the public edge's `servers` options
scaled 10× (`write 3s`) serves a QR stand-in host and a portal host whose `/invoices/package` route
sets `timeouts { write_timeout 8s }`; `flush_interval -1` so bytes stream. Result on both images:
every host, the package route included, is cut at 3 s (3 KiB). Without the server `write`, a
route-level `write_timeout 3s` cuts nothing (6 KiB in 5 s). Configurations and commands are in the
PR's comment.
