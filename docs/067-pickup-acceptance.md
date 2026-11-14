# 067 — Svoz (PPL pickup): repeatable acceptance with the simulation, DEV plan, morning walkthrough

Night queue 2026-11-14 (owner + Codex). Covers doc 029 §11. **Nothing here runs against PPL TEST or
production, nothing changes DEV or PROD.** #188 stays in independent review; merge and the DEV
deployment follow only after it.

## 1. What is verified where

| Level                                     | Carrier                                                   | Where                                          | Covers                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API e2e `ppl-pickups.e2e.test.ts`         | real PPL adapter → simulated PPL API (`fake-ppl.ts`)      | per-run test database (CI and local)           | body, plan of concrete parcels, `CARRIER_IMPLIED`, recovery of a written pickup, uncertain answers, cancellation incl. the audited closing, concurrency, replays, DB rules |
| API e2e `shipments-access.e2e.test.ts`    | test carrier                                              | per-run test database                          | real sign-in: closing an uncertain cancellation needs `shipments:resolve_uncertain`; another site 404                                                                      |
| Playwright `workflow-pickups.spec.ts`     | test carrier                                              | standard e2e set (CI)                          | order + cancel on the board, 390 / 320 px                                                                                                                                  |
| Playwright `workflow-pickups-ppl.spec.ts` | real PPL adapter → simulated PPL API, steered by the spec | **isolated** e2e set `E2E_CARRIER=ppl` (local) | the whole walkthrough through the real UI (§2); skipped in the standard set and in CI                                                                                      |

The isolated set has its own database (`ayvo_e2e_svoz`), ports (web 3200, API 4200, Finance 4210)
and the simulation on 127.0.0.1:4195 (`E2E_FAKE_PPL_PORT`; not 4190 — a port the Fetch standard
blocks). The simulation's test control route (`/__fake-ppl/control`) exists only in the test file.

## 2. The walkthrough (isolated, repeatable)

```bash
cd <checkout of #188>
pnpm build
cd apps/web
E2E_CARRIER=ppl E2E_WEB_PORT=3200 E2E_API_PORT=4200 E2E_FINANCE_PORT=4210 \
  E2E_DB_NAME=ayvo_e2e_svoz AYVO_SCREENSHOT_DIR=/tmp/svoz-shots \
  npx playwright test e2e/workflow-pickups-ppl.spec.ts
```

It creates its own synthetic data (site CZ-PREROV-01 of the test database, PPL settings against the
simulation verified by "Ověřit připojení", three orders: A = 2 parcels, B = 1, C = 2) and checks:

1. Labels exist and **no pickup was created** for them; nothing selected → "Vybráno 0 obj., 0
   balíků", the button disabled.
2. A part of the ready orders (A + B, not C) → "Objednat svoz PPL" for tomorrow → **Potvrzeno
   dopravcem**, the history lists each parcel with its PPL number, "Stav balíku dnes".
3. **Zrušit svoz** — PPL accepts but does not show it cancelled yet → "Storno čeká na potvrzení
   dopravce; balíky zůstávají blokované"; A cannot be selected and the API refuses another day.
4. The simulation shows `Canceled` → "Zjistit stav u dopravce" → **Svoz zrušen dopravcem**; A is
   selectable again.
5. The **same labels** planned again (A + B, the day after tomorrow) — the same numbers.
6. PPL collects 1 of A's 2 parcels (tracking) → the pickup is cancelled → the board shows "převzato
   1 · ke svozu 1" → a new pickup announces **only the remaining parcel**.
7. Separately: PPL reports C's first parcel **delivered without a pickup scan** → "převzato 1" →
   only the second parcel is planned.
8. Separately: **PPL down** while ordering → "Nejisté – odpověď dopravce se ztratila" in Czech
   ("Odpověď dopravce se nepodařilo získat…"), the site waits; after the outage "Zjistit stav"
   does not find it → "Uzavřít jako neobjednaný" (reason, check box) → a new pickup is confirmed.

Run 3× in a row on 2026-11-14: 3/3 each time. Screenshots (desktop 1280 and phone 390, synthetic
data only): `/home/ayvo/svoz-walkthrough-20261114/` (16 files, `svoz-01` … `svoz-08`).

Not covered by the walkthrough (API e2e covers it): a parcel held **after the original day** while a
cancellation waits (the API test moves only the service's "today"), the recovery of a written
pickup after a restart, the closing of an uncertain cancellation.

**Fixed during the walkthrough:** a waiting pickup was rendered twice (its card and the history —
duplicate buttons); the operator saw the English technical "The carrier did not answer usably" (now
Czech texts per error code); "Balíky: 0/2" on a held order was misleading (now "Balíky: 2 ·
převzato 1 · ke svozu 1").

**Ideas, not done:** show "Ověřit lze od …" only while it is in the future (needs a server-side
"now"); a per-order note why an order is not selectable while another pickup waits (today the card
above says it).

## 3. DEV — read-only state (2026-11-14 21:30 UTC)

- `api` / `web` `1ec991c895ee-20261111T162604Z`, `finance` `finance-1ec991c…`, `portal-web`
  `14ced8b89a56-…` — all healthy; DEV does **not** contain #188.
- Disk: 150 GB, 102 GB used, **43 GB free** (71 %); Docker build cache 12.3 GB (8.9 GB reclaimable).
- DEV has `APP_ENV=development` and the **real PPL TEST** credentials (key names only:
  `PPL_TEST_CLIENT_ID`, `PPL_TEST_CLIENT_SECRET`, `CARRIER_CREDENTIALS_KEY`). The simulated PPL API
  is accepted **only with `APP_ENV=test`** (`PPL_TEST_API_BASE_URL_FOR_TESTS`, env.ts) — so **DEV
  cannot use the simulation today**: on DEV, "Objednat svoz PPL" and "Zrušit svoz" would call the
  real PPL TEST environment.

## 4. After approval: what goes to DEV and what may be clicked there

Plan (each its own approval; the deployment only by `scripts/deploy-dev.sh`):

1. Merge #188 (after Codex's approval), CI on main green.
2. `scripts/deploy-dev.sh` → migrations `20261116090000_*`, `20261116090100_carrier_pickups`
   (additive, new tables only).
3. On DEV **without** a PPL TEST approval, only these actions are safe: open Expedice → Svoz, see the
   candidates, the carrier card, the environment badge, an empty history; "Zjistit stav" has nothing
   to look up. **Do not press "Objednat svoz PPL" or "Zrušit svoz"** (real PPL TEST calls).
4. **New, not verified — needs a decision:** a DEV PPL simulation like the bank's `rb-simulation`
   (a separate container serving the simulated PPL API on DEV, an explicit connection
   `PPL_SIMULATION` usable only with `APP_ENV=development`, never in production). That is new
   infrastructure and code (connections, env rules, compose) — not part of #188.
   Alternatively one **owner-approved PPL TEST run** on DEV (like doc 029 §10): one pickup, one
   cancellation, the exchange log outside git — the PPL TEST environment may not process pickups
   like production.

## 5. Morning click-through (no setup)

1. Look at the screenshots in `/home/ayvo/svoz-walkthrough-20261114/` in this order: `svoz-01`
   (nothing selected) → `02` (ordered: parcels and numbers) → `03` (cancellation waiting: held) →
   `04` (confirmed: free) → `05` (partial pickup: only the rest) → `06` (delivered without a scan)
   → `07` (lost answer, Czech text, closing) → `08` (after the outage).
2. To see it live once more: the command in §2 (about 5 minutes with `pnpm build`, 40 s without).
