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
  is accepted **only with `APP_ENV=test`** (`PPL_TEST_API_BASE_URL_FOR_TESTS`, env.ts) — so DEV
  cannot use the simulation: on DEV, "Objednat svoz PPL" and "Zrušit svoz" call the PPL TEST
  environment (own database, no real transport — §4).

## 4. After approval: DEV acceptance on the existing PPL TEST connection

Owner 2026-11-15: DEV has its own PPL **TEST** credentials, and PPL documents that the TEST
environment has its own database and carries out no real transport (ppl-cpl-api.apidog.io,
"Obecné"). So the actions on DEV run against **PPL TEST**, not only the isolated simulation — no new
infrastructure (no DEV simulation container). Outages, races and partial pickups stay deterministic
in the isolated simulation (§2, API e2e); PPL TEST cannot be steered.

Order (each step its own approval): Codex's independent approval of #188 → merge (CI on main green)
→ `scripts/deploy-dev.sh` (migrations `20261116090000_*`, `20261116090100_carrier_pickups`, additive)
→ this checklist. Nothing on DEV before that.

Checklist (one synthetic order, synthetic hotel/address; record into a note **outside git** — no
credentials, tokens, or raw logs):

1. **Environment.** Správa systému → Dopravci: the site's connection is `PPL_TEST` (the TEST
   badge), credentials shown only as "uloženo" (never their values); Expedice → Svoz shows "Testovací
   prostředí dopravce – žádný skutečný svoz" and the site's sender address. "Ověřit připojení"
   passes.
2. **Synthetic order → label.** A finished crate of the site, a synthetic order of a synthetic
   hotel, "Vytvořit štítky" → the label (PDF preview; download, a reprint via the print queue if a
   DEV agent exists — no physical printer needed), "Připraveno k vyzvednutí". Record the parcel
   number(s). Check: **no pickup** exists for it (Svoz → history empty for it).
3. **Pickup.** Svoz → the order selected alone → day = tomorrow (no window) → "Objednat svoz PPL" →
   confirm. Record: our code `SV-…`, the status ("Potvrzeno dopravcem" or "Dopravce zpracovává"),
   PPL's number and state when shown ("Zjistit stav u dopravce" if needed), the time it took.
4. **Cancellation.** "Zrušit svoz" (reason) → record the status ("Storno čeká na potvrzení
   dopravce" / confirmed), each "Zjistit stav" until **`Canceled`** is shown ("Dopravce svoz zrušil"),
   how long it took. While it waits: the order is **not** selectable (held).
5. **Same label again.** After `Canceled`: the order is selectable again; a new pickup for the day
   after tomorrow lists **the same parcel number(s)** (do not cancel or keep — decide then; the TEST
   environment carries nothing).
6. **Write down** the observations, PPL TEST's real limits (e.g. pickups refused for TEST, `Canceled`
   never shown, a cut-off, a missing number) and any concrete difference to the documented contract
   (doc 029 §11) — into the morning report, not into a public PR comment.

To repeat the purely simulated walkthrough (no PPL, no DEV): §2 (one command, about 40 s after
`pnpm build`; screenshots of 2026-11-15: `/home/ayvo/svoz-walkthrough-20261115/`).

Out of scope here: the physical pickup, PROD, returns.

## 5. Morning click-through (no setup)

1. Look at the screenshots in `/home/ayvo/svoz-walkthrough-20261114/` in this order: `svoz-01`
   (nothing selected) → `02` (ordered: parcels and numbers) → `03` (cancellation waiting: held) →
   `04` (confirmed: free) → `05` (partial pickup: only the rest) → `06` (delivered without a scan)
   → `07` (lost answer, Czech text, closing) → `08` (after the outage).
2. To see it live once more: the command in §2 (about 5 minutes with `pnpm build`, 40 s without).
