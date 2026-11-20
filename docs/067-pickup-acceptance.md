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

## 3. DEV — read-only state (2026-11-14 21:30 UTC; current state in §6)

- `api` / `web` `1ec991c895ee-20261111T162604Z`, `finance` `finance-1ec991c…`, `portal-web`
  `14ced8b89a56-…` — all healthy; DEV does **not** contain #188.
- Disk: 150 GB, 102 GB used, **43 GB free** (71 %); Docker build cache 12.3 GB (8.9 GB reclaimable).
- DEV has `APP_ENV=development` and the **real PPL TEST** credentials (key names only:
  `PPL_TEST_CLIENT_ID`, `PPL_TEST_CLIENT_SECRET`, `CARRIER_CREDENTIALS_KEY`). The simulated PPL API
  is accepted **only with `APP_ENV=test`** (`PPL_TEST_API_BASE_URL_FOR_TESTS`, env.ts) — so DEV
  cannot use the simulation: on DEV, "Objednat svoz PPL" and "Zrušit svoz" call the PPL TEST
  environment (own database, no real transport — §4).

## 4. After approval: DEV acceptance on the existing PPL TEST connection (one run: §7)

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

## 6. Coming back as a revert of #191 (2026-11-20)

#188 was merged (`795f1d8`), then taken out again by #191 (`d561680`) so the release of 2026-11-17
could go without pickups. It comes back as one PR, a `git revert -m 1 d561680` on the current
`main`.

- **The code is #188's.** For 32 of the 33 files, the diff against `main` is line for line the
  diff of #188 (`795f1d8^1..795f1d8`). The one exception is `schema.prisma`: there the union with
  commissions (`SALES_COMMISSION_TERMS_RECORD`, `SALES_HOTEL_ATTRIBUTION_RECORD` and the user
  relations of #196–#202) and `prisma format`'s alignment.
- **Nothing else changes.** Labels, tracking, Zásoby, Obchod, commissions and Finance are kept.
- **The same two migrations, byte for byte:**

  | Migration                                    | sha256 (= Prisma checksum)                                         |
  | -------------------------------------------- | ------------------------------------------------------------------ |
  | `20261116090000_carrier_pickups_enum_values` | `4d1e4daa09dbae6c13ee8fe9ccad2fa8f794b1642674298c499d9c6f648e3c37` |
  | `20261116090100_carrier_pickups`             | `b26748a8bab967f09bddf373642bcb8474e1ba812a890d838c9ff1534f4b050a` |

### 6.1 Per database

Check first, read only (`BEGIN READ ONLY`, privileged migration role):

```sql
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at
  FROM _prisma_migrations WHERE migration_name LIKE '20261116%' ORDER BY 1;
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
```

- **Both rows finished with these checksums. This is DEV, read on 2026-11-20:**
  - DEV applied them on 2026-11-16 and kept them through #191;
  - the tables are there, with 0 pickups, 0 parcels and 0 cancellations.

  `migrate deploy` has nothing to do ("No pending migrations"). Nothing on the database changes.

- **No row (a database that never ran #188, e.g. PROD if it skipped it):** `migrate deploy`
  applies both after the newer migrations already there. This was checked on a thrown-away database:
  - it ran `main` first, then this branch: both applied, and a repeat says "No pending";
  - its schema is identical to a database migrated in name order, except the order of the
    `OperationKind` enum values (cosmetic; no code sorts by them).
- **The R3-a rollback preflight (doc 058) and the order:** if R3-a (`20261119090000`) is already
  on that database, the two pickup migrations are "named before R3-a but applied after it". The
  preflight then answers `STOP_UNVERIFIED_MIGRATION` and stops a later R3-a rollback.
  - So where both are still missing, deploy this PR **before** R3-a.
  - On DEV the question does not arise: pickups are there since 2026-11-16, before R3-a.

### 6.2 A schema applied only in part earlier (safe handling, never automatic)

A partial application shows up as a row with `finished_at IS NULL AND rolled_back_at IS NULL`.

- Prisma then refuses every further `migrate deploy` (P3009).
- The running image is unaffected: an image without pickups never touches these tables.
- `deploy-dev.sh` stops before starting anything new.

What to do, each step with the owner's approval:

1. **Stop.** No automatic retry, no `migrate reset`, no restore from a backup. Keep the deploy log.
2. **Inventory, read only:** which objects of the failed file exist — tables, functions, triggers,
   indexes, the `code_counters` row `carrier_pickup`, and the enum values. Check that every pickup
   table is **empty**. The new tables are written only by the pickup module, so after a failed
   deploy they must hold 0 rows.
3. **`20261116090000` (enum values) partly applied:** added enum values cannot be removed.
   - Add the missing ones by hand with `ALTER TYPE "OperationKind" ADD VALUE IF NOT EXISTS …`
     (privileged role).
   - The end state then equals the file, so record it with
     `prisma migrate resolve --applied 20261116090000_carrier_pickups_enum_values`.
4. **`20261116090100` (tables) partly applied:**
   - In one transaction, drop only the objects of this file found in step 2, and only while their
     tables are empty. That includes the `carrier_pickup` counter row while it is still 0.
   - Then `prisma migrate resolve --rolled-back 20261116090100_carrier_pickups`, and `migrate
deploy` applies the whole file again.
   - Never finish the file by hand and mark it `--applied`: a hand-made schema would carry the
     file's checksum without being proven equal to it.
5. **After:** step 6.1's query shows both rows finished with the checksums above, and the
   pickup tables are empty.
6. **Not this procedure** (stop, ask the owner): anything that holds rows, a different checksum,
   or an object of another migration.

## 7. One TEST run on DEV: label → pickup → cancellation → confirmed by PPL → new date

### Preconditions, each its own GO

- **PPL TEST answers** (2026-11-20 20:51 CET, read by Codex): a signed-in `GET /codelist/product`
  gives 200 with 16 items, so the 404 of 15.–18. 11. is over.
- **This PR is reviewed, merged** (CI on `main` green) **and on DEV** via `scripts/deploy-dev.sh`.
  The migrations are a no-op on DEV (§6.1). This happens only after the ongoing release (#202) has
  finished.
- **The disk:** DEV has 7.0 GB free. The deploy builds images, so check the free space and the
  build cache first. If it is low, stop: no prune without the owner's approval.
- **The isolated walkthrough (§2) passed on exactly the commit to deploy.**
  - 2026-11-20, on the revert `47fbe27` (main `32e3d47` + #188): `--repeat-each=3`, both tests
    3/3. The run used DB `ayvo_e2e_svozr191` and ports 3200/4200/4210, with the simulation on 4195. Screenshots are in `/home/ayvo/svoz-walkthrough-20261120/`.
  - It covers label without pickup → part ordered → cancelled → held → confirmed → planned again
    → partial pickup, and a lost answer during an outage.

### The run (one synthetic order of a synthetic hotel, never ORD-000002)

What is sent to PPL TEST at run time:

- one `POST /shipment/batch` (step 1);
- one pickup order (step 2);
- one pickup cancellation (step 3).

No other POST, and nothing is ever re-sent. Record everything in a note **outside git**, without
credentials, tokens or raw logs.

| #   | Step                                                                       | Expected                                                                                                                                        | Record                                |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 0   | Správa systému → Dopravci; Expedice → Svoz                                 | `PPL_TEST` (TEST badge), credentials "uloženo"; "Testovací prostředí dopravce – žádný skutečný svoz", sender address; "Ověřit připojení" passes | time                                  |
| 1   | **Label:** a finished crate, a new synthetic order → "Vytvořit štítky"     | label (PDF), "Připraveno k vyzvednutí", **no pickup** for it                                                                                    | our `SHP-…`, PPL parcel number(s)     |
| 2   | **Pickup:** select only this order, tomorrow → "Objednat svoz PPL"         | "Potvrzeno dopravcem", or "Dopravce zpracovává" → "Zjistit stav u dopravce"                                                                     | `SV-…`, PPL number, duration          |
| 3   | **Cancellation:** "Zrušit svoz" (reason)                                   | "Storno čeká na potvrzení dopravce; balíky zůstávají blokované"; the order not selectable, another date refused                                 | time                                  |
| 4   | **Confirmed by PPL:** "Zjistit stav u dopravce" until PPL shows `Canceled` | "Svoz zrušen dopravcem". Only PPL's `Canceled` confirms it, never the time passed or an empty read                                              | every check, time to `Canceled`       |
| 5   | **New date:** after `Canceled`                                             | the order selectable again; a pickup for the day after tomorrow lists **the same parcel number(s)**                                             | `SV-…`; keep or cancel (decided then) |
| 6   | Notes                                                                      | real limits of PPL TEST (refusals, `Canceled` never shown, cut-off, missing number), differences to doc 029 §11                                 | the report, not a public PR           |

**Stop rules:**

- An answer lost in step 1, 2 or 3 makes the request "Nejisté". Never re-send it and never start a
  second one: only "Zjistit stav"/"Ověřit", and close it by hand only as in §8 3.
- If `Canceled` is not shown by the end of the day, the pickup stays held. Nothing is closed by
  hand without evidence.

## 8. SHP-000002-1 (ORD-000002): the open uncertain label request

**State (DEV, read 2026-11-20):**

- shipment `SHP-000002` `REQUESTING`;
- request `SHP-000002-1` `SENT` / `NO_ANSWER`, sent 2026-11-15 18:14:41 UTC, no batch id, never
  resolved;
- parcels `SHP-000002-1-1..3`.

The POST was sent three minutes before PPL TEST started answering 404 to every signed-in call
(15.–18. 11.).

**Codex's read (2026-11-20 20:51 CET):** one `GET /shipment` for the three parcel references
`SHP-000002-1-1..3` gave HTTP 200 with 0 records. Nothing was written and nothing was sent.

**Why that is not yet a definitive "not created":**

- PPL documents neither which reference `GET /shipment?CustomerReferences` matches nor how far
  back it searches. The code says so in `ppl-gateway.ts` `poll`.
- In a set the batch carries the shipment-level `referenceId` `SHP-000002-1`, while each item
  carries its own CUST reference, and only the item references were read.
- PPL TEST was in a 404 state for four days and may have reset its data. An empty answer could
  mean "never created" as well as "no longer visible".

**Supported ways, in this order:**

1. **"Ověřit stav u dopravce"** in the shipment's detail (`POST
/api/admin/orders/:code/shipment/resolve`, `shipments:prepare`).
   - Without a batch id the PPL adapter makes **no call** and answers `UNKNOWN`. The request
     stays `SENT` / `NO_ANSWER`.
   - It writes only its operation record and the request's message, on DEV.
   - It cannot decide anything, so it is not needed for this decision.
2. **Evidence from PPL itself:** a written answer from PPL support to the prepared question
   (`~/PPL-SVOZ-20261117.md` §4). It must say that **no batch / shipment** exists in TEST for
   `referenceId` `SHP-000002-1` and the CUST references `SHP-000002-1-1..3`. Equally good is the
   same check in PPL's own TEST portal by the owner. Keep it with Codex's read in the note outside
   git.
3. **Only with that evidence and the owner's decision: "Uzavřít nejistý požadavek ručně"**
   (`POST /api/admin/orders/:code/shipment/abandon`, `shipments:resolve_uncertain`, ADMIN, a reason
   that names the evidence and its date, the check "Ověřil(a) jsem u dopravce, že zásilka
   nevznikla").
   - The request becomes `NOT_CREATED` / `CLOSED_BY_PERSON` and the shipment `DRAFT`.
   - It is audited as `LABELS_NOT_CREATED` with `manual: true`.
4. **What does not happen:**
   - no reset, and no SQL change on the request;
   - no new label for ORD-000002, also not after step 3, unless the owner decides it separately;
   - no `POST` "to see whether it comes back".

ORD-000002 does not block §7: the pickup board offers only orders "Připraveno k vyzvednutí", and
the uncertain request belongs to its own shipment only.
