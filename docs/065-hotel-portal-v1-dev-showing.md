# 065 — Hotel portal v1 on the DEV preview (dev-portal.ayvo.co): how to show it safely

Status: **plan for the owner's approval** — nothing in it has been done. It shows the integrated
v1 (#148 contracts + A1/A2 boundary, #149 deliveries, #170 Moje hotely) on the existing private DEV
portal (doc 052: tailnet only, `dev-portal.ayvo.co`). Public PROD (#178, doc 064) is not part of
it. Every step marked **[approval]** waits for the owner's explicit yes.

## 1. What is already proven (isolated, no shared DEV data)

- The real-units walk (`PORTAL_WEB_WALK=1`, per-run test database, the built portal-web, the test
  carrier): invitation, activation + TOTP, Moje hotely with the nearest dispatch and the latest
  shipments, the switcher of two hotels, a hotel's orders in every state (planned, picked and
  complete, labelled and waiting for the carrier, on the way, delivered), the next 60 days of a
  switched-on supply plan, signed contracts (PDF byte-identical), invoices, PDF, ZIP, another
  payer's hotel 404, a replaced and a revoked grant, Finance down. 9/9; screenshots at 390 / 1440
  px in `docs/screenshots/portal-v1-walk/`.
- The boundary: an invoices-only grant and a fenced former payer get 404 on detail, profile,
  contracts and deliveries, keep their own invoices (API suites; `portal-boundary-review`).
- CI of the combination: PR #182 (the exact head of #170).

## 2. What the DEV showing needs — and what is blocked

| #   | Need                                                                                                                                        | State                                                                           | Who                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Disk for a full build: the rule is ≥ 12 GiB free; today ~7.8 GiB                                                                            | **blocked**                                                                     | owner [approval] of §3 cleanup                    |
| 2   | A reviewed commit to build: the head of #170 (= #148 + #180 + #149 + #170), not merged                                                      | needs the owner's yes to run **unmerged** code on DEV, or the merges first      | owner [approval]                                  |
| 3   | The shared DEV database migrated: Core A1 + A2 (`20261114090000`, `…090100`, `20261115090000`, `…090100`) and Finance A2 (`20261115100000`) | additive; A2's model decisions (ADR 0048) still open                            | owner [approval]                                  |
| 4   | Synthetic data on DEV: two payers, ≥ 2 hotels, agreements, TEST invoices, a signed contract, a supply plan, orders                          | **not created** (shared DEV)                                                    | owner [approval] of §5                            |
| 5   | Portal accounts: DEV sends auth mail for real (`AUTH_MAIL_DRIVER=google-relay`) — an invitation is a real e-mail                            | needs an approved AYVO test mailbox                                             | owner [approval]                                  |
| 6   | Orders "on the way" / "delivered" on DEV come only from the carrier's events (PPL **test** API on DEV); never fabricated                    | may not progress in PPL's test system; planned / prepared / ready are reachable | owner [approval] to hand test parcels to PPL test |

## 3. Disk [approval]

Docker holds 217 `ayvo-dev-preview/*` images (≈ 32.6 GB reclaimable); 5 are in use. Proposed:
keep every image a container uses and the two newest releases per service (rollback), remove the
other `ayvo-dev-preview/*` tags by name — never `prune`, never volumes, never other projects:

```bash
# Dry run first (lists only):
docker ps --format '{{.Image}}' | sort -u > /tmp/in-use
for repo in api web portal-web marketing; do
  docker images "ayvo-dev-preview/$repo" --format '{{.CreatedAt}} {{.Repository}}:{{.Tag}}' |
    sort -r | awk 'NR > 2 { print $NF }'
done | grep -vxF -f /tmp/in-use
# After the owner's yes, the same list piped to: xargs -r docker image rm
```

Also the author's own build outputs (`apps/portal/.next` in six worktrees, ~750 MB) and a test tag
(`ayvo-savecheck/a:t1`). Recheck `df -h /` ≥ 12 GiB before building.

## 4. Deploy the combination [approval]

From a clean checkout of the approved commit (§2 row 2), in this order, with the existing scripts
(doc 052, doc 013; each takes its own pg_dump / edge backup first and refuses on a wrong state):

```bash
cd /opt/ayvo/repos/AyvoOS-deploy-<commit12>        # a fresh worktree of the approved commit
scripts/deploy-dev.sh --check && scripts/deploy-finance-dev.sh --check
export DEV_TAILNET_IPV4="$(tailscale ip -4)"
export PORTAL_IMAGE_TAG="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
unset DEV_PORTAL_DOMAIN PORTAL_CORE_TOKEN PORTAL_FINANCE_TOKEN
portal_compose=(docker compose -f deploy/dev/compose.yml
  --env-file /opt/ayvo/secrets/dev-preview.env --profile portal)
flock -n /opt/ayvo/logs/.deploy-dev-preview.lock "${portal_compose[@]}" build --pull portal-web
scripts/deploy-dev.sh             # Core: backup, A1 + A2 Core migrations, api + web
scripts/deploy-finance-dev.sh     # Finance: backup, A2 Finance migration, finance
flock -n /opt/ayvo/logs/.deploy-dev-preview.lock "${portal_compose[@]}" up \
  --detach --wait --wait-timeout 120 --no-deps --no-build portal-web
scripts/deploy-dev.sh --edge      # only if the edge config changed (it does not in this combination)
```

Order matters: Core first (its RLS guard lets the running old portal-web see only operational
rows — fail-closed — until the new one runs), then Finance (an older Finance cannot write terms
once migrated: changes of payer wait for the new image), then portal-web.

Keep the previous images and the deploy worktree that Caddy runs from (doc 052; memory of the
3978206 incident) until the new release is accepted.

## 5. Synthetic data on DEV [approval]

Through the normal UIs (never SQL), as an ADMIN, all names marked "(syntetický)":
Finance: two payers A, B; hotels H1, H2 (A) and H3 (B); their agreements; TEST invoices (issued
singly, `TEST`, mail in simulation); a signed contract PDF uploaded for H1. Orders: H1 planned
orders; one picked and complete; one labelled and ready (PPL **test** — only with row 6's yes);
H1's supply plan with two plan days a month, switched on. Portal: A's grant {H1, H2} and B's
{H3} through the payer page (invitations to the approved test mailbox — row 5).

## 6. Verify on dev-portal.ayvo.co (tailnet)

Per doc 052 §Verify plus: Moje hotely (nearest dispatch, latest shipments, the switcher), Dodávky
(real states only, plan days for 60 days, nothing invented), Smlouvy (only signed, PDF), Faktury,
PDF, ZIP; B cannot open A's hotel or documents (404); a change of payer of H2 on the normal
Finance route → A keeps H2's invoices, loses its operations at once. At 390 and 1440 px.

## 7. Rollback and risks

- portal-web: the previous image (doc 052). Core / Finance: `scripts/deploy-dev.sh --rollback`
  runs no migrations — after A1/A2 the RLS guard stays: the older core sees only operational,
  unfenced grant hotels (rehearsed: #180 comment 6798502567); an older Finance cannot write terms.
  Undoing the schema is a restore from the pre-migration dump (doc 013), never automatic.
- The shared DEV host, Caddy, PostgreSQL and Redis remain one failure domain (doc 052).
- The ZIP limit for parked transfers (#178, awaiting approval) is not in this combination; on the
  private tailnet DEV it is not a public exposure.
- Login hotfix: in #148 (the same change as #181), so DEV gets it with this combination.
