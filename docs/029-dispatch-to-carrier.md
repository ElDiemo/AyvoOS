# 029 — Completing the order and preparing it for carrier pickup

Status (2026-10-19):

| Part                                                     | Implemented | Tested                                   | Deployed |
| -------------------------------------------------------- | ----------- | ---------------------------------------- | -------- |
| Order flow, shipment, parcels, labels, ready, hand-over  | yes (PR A)  | automated (API, DB rules, Playwright)    | no       |
| Carrier boundary, test-only carrier, polling, cancelling | yes (PR A)  | automated, with the test-only carrier    | no       |
| Site carrier settings (PPL), PPL CPL adapter             | yes (PR B)  | automated against a simulated PPL server | no       |
| Carrier connections in the administration (ADR 0027)     | yes (PR B)  | automated (API, Playwright)              | no       |
| Real PPL test environment                                | —           | one authorized run, §10                  | no       |
| Physical printing on the Zebra ZD220                     | —           | **open** (physical acceptance, §5)       | no       |

Scope approved by the owner on 2026-10-18 and 2026-10-19. Continues doc 028 (orders, picking) on
the same order; uses W1 (doc 025 §10) for weights and dimensions; implements the carrier boundary
planned in doc 008 and the per-site carrier rule of doc 022 §8.

Out of scope (not implemented, not pretended): delivery, returns, billing, the hotel portal, partial
or split shipments, ordering a pickup ("svoz" — a PPL pickup order is not our hotel order),
automatic printing (Raspberry Pi), the public QR passport, ESG, a production PPL connection.

## 1. One flow, on the order

Everything is on the order detail in **Expedice** — no separate shipment list, no second worklist,
no "create shipment" button: open the order → scan the finished crates → complete picking →
create the carrier labels → print and apply them → confirm **Připraveno k vyzvednutí** → after the
real hand-over confirm **Předáno dopravci**.

The order status is the **one** process status; the shipment records where the carrier request
stands. The database couples them, so they cannot contradict each other:

| Order status (UI)                            | Meaning                                                              | Shipment                                                          |
| -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `OPEN` (Otevřená / Rozpracovaná)             | picking                                                              | none                                                              |
| `READY_TO_DISPATCH` (Kompletace dokončena)   | picking complete; shipment and parcels derived automatically         | `DRAFT` → `REQUESTING` → `LABELED`; `CANCELLING` while cancelling |
| `READY_FOR_PICKUP` (Připraveno k vyzvednutí) | the operator confirmed the labels are printed and applied            | `LABELED`                                                         |
| `HANDED_TO_CARRIER` (Předáno dopravci)       | the operator confirmed the real hand-over; crate cycles `DISPATCHED` | `LABELED`                                                         |
| `CANCELLED`                                  | cancelled (only before anything reached a carrier)                   | cancelled                                                         |

None of these means "delivered", "the bottle is at the hotel" or "a completed reuse cycle"
(ADR 0011). A created or downloaded file is not evidence of printing; only the explicit
confirmation is. The bottles keep their status (`FILLED`); nothing moves stock.

## 2. Model (owner-approved: internal shipment, parcels and their audited history)

| Table                       | Purpose                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shipments`                 | `SHP-000001`; one live per order (the whole order together); carrier, **connection and environment recorded at the first request** (snapshot)    |
| `shipment_parcels`          | one per allocated crate (= one physical crate = one parcel = one label); allocation (so its bottles), crate, cycle, calculated reference, number |
| `shipment_parcel_weighings` | optional actual weighings, append-only, corrections keep the previous one; only before the labels are requested                                  |
| `shipment_carrier_requests` | each attempt: unique client reference, the payload sent **including the site's carrier settings used** (snapshot, no secrets), status, polling   |
| `shipment_labels`           | **one label file per parcel** and optionally the complete document; stored once, never replaced; PDF or ZPL with its DPI                         |

The shipment history is part of the order history (`order_events`). Delivery data are the
**order's snapshot** (doc 028); the sender comes from the site's carrier settings.

## 3. Rules

- **Derived, not entered:** completing the picking creates the shipment and one parcel per crate in
  loading order (same transaction).
- **Frozen content:** a completed order's crates cannot be removed (doc 028); while a carrier
  request is unresolved, labels exist or a cancellation runs, the order cannot be cancelled
  (`SHIPMENT_AT_CARRIER`) and no second shipment exists (one live per order). A draft that never
  reached a carrier is cancelled with the order.
- **At most one send per attempt:** the request is written first (`PREPARED`), then claimed by one
  conditional update (`SENT`) — only the claimer calls the carrier. A double click, a concurrent
  click or a replay finds the unresolved request and sends nothing.
- **Time limit:** every carrier call aborts after `CARRIER_CALL_TIMEOUT_SECONDS` (default 30 s);
  an aborted or answerless call is **unknown** (`NO_ANSWER`), never "failed", never re-sent.
- **In-flight window:** a claimed request may still be in flight for `CARRIER_SETTLE_SECONDS`
  (default 120 s, at least 3 × the time limit outside tests), measured **from `sent_at` in database
  time** regardless of any error code. Before it ends: no lookup and no manual closing; the UI
  shows from when "Ověřit" is possible.
- **Only the carrier settles an uncertain request:** "Ověřit u dopravce" looks it up by its
  references. Created → labels are fetched; the carrier itself confirms nothing was created →
  `NOT_CREATED`; the carrier cannot tell (e.g. PPL without a batch id, §5) → it **stays uncertain**.
  The passing of time never marks anything `NOT_CREATED` and nothing is re-created blindly.
- **Exceptional manual closing** (`shipments:resolve_uncertain`, ADMIN only; a reason and an
  explicit check box): a person who verified with the carrier that nothing was created closes an
  uncertain request (`NOT_CREATED`, `CLOSED_BY_PERSON`, audited) — a claimed one only after the
  in-flight window, an accepted one only after its automatic checks ended; never one the carrier
  reported as created. The UI offers it only when the server would allow it. The dialog states the
  risk: if a shipment does exist, the next request creates a **second** one at the carrier.
- **Asynchronous carriers:** an accepted request (`ACCEPTED`, e.g. a PPL batch id stored at once)
  is polled by a background worker: back-off 10 s, 20 s, 40 s … up to 5 min, at most 30 times; the
  state is in the database, so a restart continues; several API processes share the work
  (`SKIP LOCKED`). After the limit, a person checks with "Ověřit". The same applies to labels that
  could not be downloaded yet (`CREATED`).
- **Bounded, always:** every automatic round ends scheduled (counted) or stopped; problems that
  need a person (`CARRIER_PARCEL_MISMATCH`, `LABELS_INVALID`, `CARRIER_PARTIAL`) stop the polling;
  "Ověřit" looks a mismatch up again. Nothing is downloaded or stored unless the shipment is still
  `REQUESTING` (never during a cancellation); a user's inline processing holds a lease so the poller
  does not work on the same request at the same time.
- **Partly created set:** if the carrier creates only some parcels, the request stays `CREATED`
  (`CARRIER_PARTIAL`, no labels) and is cancelled at the carrier — every created number.
- **Late answers are never silent:** a carrier creation or cancellation confirmation arriving after
  the request or cancellation was closed locally is written to the history (`CARRIER_LATE_ANSWER`)
  and logged as an error, for a person to check with the carrier.
- **Carriers without cancellation** through their interface are not used for new shipments
  (`CANCELLATION_UNSUPPORTED`): otherwise a created-but-unusable shipment would have no way out.
- **Labels:** stored only after checking: each parcel's number is proven per parcel (never by
  position), each file really is PDF/ZPL (magic bytes), ≤ 5 MB. A mismatch keeps the request open
  (`CARRIER_PARCEL_MISMATCH`, `LABELS_INVALID`) for a person.
- **Cancelling the preparation:** first **recorded** (`CANCELLING`, reason, under the order lock);
  a ready-for-pickup order goes back to `READY_TO_DISPATCH`, so it cannot be handed over meanwhile;
  the database ties that step to the cancellation. Then the carrier is asked (with the request's own
  connection): its confirmation cancels (`carrier_cancelled_at`, a fresh draft of the same crates);
  only its **definitive** refusal (rejected request, or "not cancelled" after it accepted the
  request — e.g. already picked up) returns the shipment (`LABELED`, or `REQUESTING` for a created
  shipment whose labels never became usable, which then resumes its label download); "still
  processing" or a lost answer stays `CANCELLING` for "Ověřit zrušení".
  Never cancels the order, releases crates or returns stock. Actual weighings are entered again on
  the new draft.
- **Weights:** calculated reference per parcel (Hotovo snapshot or, without one, the references at
  derivation — labelled); optional actual weighing kept apart; the carrier gets the actual weight,
  else the reference, only where it uses weights and its unit is confirmed. Missing required data are
  shown and refused (`SHIPMENT_DATA_MISSING`), never 0 or invented; no carrier limit hard-coded.
- **Snapshots:** each request keeps the settings it used; later changes of the site's settings never
  change it; lookups, labels and cancellation use the request's connection and environment.

## 4. Carrier boundary

`apps/api/src/carriers/carrier.ts`: `create` (once; refusal vs. unknown), `poll`, `labels`
(per parcel + complete), `cancel` (idempotent; may be asynchronous) and `cancelStatus`, plus the
carrier's rules. The registry gives the carrier for a **new** request at a site (from its settings)
and the carrier of an **existing** request (its connection and environment only).

- No site carrier, or the site's settings incomplete/disabled, or the server lacks the credentials:
  the order shows why ("Dopravce není pro tuto provozovnu připravený" + the reason); nothing is
  pretended.
- `CARRIER_PROVIDER=test` — a fake carrier for automated tests (labels "TEST CARRIER - NOT A REAL
  LABEL") — is refused unless `APP_ENV=test`.

## 5. PPL (CPL API) — facts from the authoritative documentation (ppl-cpl-api.apidog.io, 2026-10-19)

- OAuth2 client credentials (`scope=myapi2`), token 30 min, at most 12 tokens/min — reused until
  expiry. Test `https://api-dev.dhl.com/ecs/ppl/myapi2`; production URL exists but is **not used**.
- `POST /shipment/batch` → `201`, batch id only in the `Location` header (stored at once) →
  `GET /shipment/batch/{id}`: `importState` `Accepted | InProcess | Complete | Error`, each item with
  `shipmentNumber`, `labelUrl`, and set parcels as `relatedItems` (`relationType: ShipmentSet`).
- **Mapping parcels to crates:** batch status has no per-parcel index. Each set item therefore
  carries its own `externalNumbers` (`CUST` = our parcel reference); `GET /shipment` returns
  `externalNumbers` per shipment number → each number is mapped by that proof. If the proof is
  missing, the labels are not accepted (open for a person) — never mapped by position. A set is
  sent **without** a shipment-level `externalNumbers`: PPL applies a shipment-level `CUST` to every
  parcel of the set (live runs 2026-10-19 and -20, PPL support); `referenceId` stays. A single
  parcel keeps its shipment-level `CUST`.
- **Limits and paging (PPL37-R2):** a set has at most **50** parcels (documented
  `numberOfShipments` "Max 50"; the general page says 100 per address — the stricter value applies
  until PPL clarifies). A larger order is **refused before anything is sent** (`PPL_SET_TOO_LARGE`),
  never split into several shipments on our own. `GET /shipment` takes at most 50
  `ShipmentNumbers` per request and answers in pages (`Limit`/`Offset`,
  `X-Paging-Total-Items-Count`): the adapter asks in chunks of 50 and reads every page; a page that
  cannot be read makes the whole answer unknown (never a partial mapping or state).
- **No idempotency key, duplicate `referenceId` behaviour and `CustomerReferences` matching are not
  documented**; a lost `Location` header has no documented lookup → such a request stays uncertain.
- Labels: `labelSettings.format` (`Pdf`/`Zpl`/…), `dpi` 203–1200 (ZPL); per-parcel `labelUrl`
  (`/data/{guid}`) on the same API host, Bearer token; batch valid ≤ 30 days (AYVO keeps a copy).
  Downloads go only to the configured API origin, without redirects, size-limited, content-checked.
- Weight per set item optional; **unit not documented** → not sent until PPL confirms it
  (mandatory towards Germany — DE is therefore not supported yet). No dimension fields.
- Latin characters only (examples contradict it) → diacritics are stripped in what is sent.
- Cancel `POST /shipment/{number}/cancel` → `202` (asynchronous) → confirmed only when `GET /shipment`
  shows `Canceled`.
- Pickup ordering is a separate endpoint (`/order/batch`) and is **not used**.

**How the adapter handles what the documentation leaves open** (to be confirmed in the PPL test
environment before any use):

- The token is obtained **before** the batch is sent: if PPL refuses the credentials or cannot be
  reached, the batch was certainly not sent → refused (`PPL_AUTH` / `PPL_UNAVAILABLE`), never
  uncertain. A creating request is sent once and never repeated by the client (not even after a
  401, which PPL documents as "not processed"); reads are retried once after a 401.
- Batch id: the path segment after `/shipment/batch/` of the `Location` header (absolute or
  relative); its format is not documented, only a conservative character set is required.
- Parcel mapping: every created number must belong to exactly one parcel by its own `CUST`; a parcel
  claimed by two numbers, or a number left over, is not proven (`CARRIER_PARCEL_MISMATCH`).
- Labels: absolute or host-relative `labelUrl`, only under the API's `/data/`; a foreign host, a
  redirect or an oversized file is a contract violation for a person (`LABELS_INVALID`, not
  retried). The complete A4 document only as PDF and only when PPL returns it as one file. `dpi` is
  sent only for ZPL.
- Cancelling: numbers already `Canceled` are skipped (asking again after a lost answer is safe);
  a definite refusal only when PPL refused every number and none is cancelled; a partly cancelled
  set stays `CANCELLING` for a person (no automatic return). States treated as "with the carrier":
  `PickedUpFromSender`, `OutForDelivery`, `Delivered`, `DeliveredToPickupPoint`, `NotDelivered`,
  `Undelivered`, `BackToSender` (names from the code list, unverified).
- Query parameters `ShipmentNumbers`, `Limit` (50), `Offset` — at most 50 numbers per order.
- Text: diacritics removed and Ł/ß/Đ/typographic marks transliterated; a value longer than PPL's
  limit or with other characters refuses the request before sending (nothing is cut). Deliveries to
  Germany are refused until the weight unit is confirmed.

**Open questions for PPL** (also in the PR): duplicate `referenceId`; does `CustomerReferences`
match `referenceId` or `externalNumbers`; lookup of a batch after a lost `Location`; is each set
item's `externalNumbers` returned per parcel by `GET /shipment`; weight unit and precision; maximum
parcels per set (20 / 50 / 100 in different places); cancellation cut-off and behaviour for set
parcels; label size — e-mail 127 × 101 mm (CZ) / 150 × 101 mm (EU) vs. documentation 127 × 110 mm /
150 × 100 mm; which product codes our contract allows (`BUSS`?), and whether diacritics are accepted.

## 6. Permissions (catalogue migration; ADMIN only)

| Permission                    | Scope                    | Use                                                                                                       |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `shipments:read`              | active site, `WAREHOUSE` | the order's shipment, parcels, weights, labels, carrier numbers                                           |
| `shipments:prepare`           | active site, `WAREHOUSE` | actual weighing, create/resolve labels, ready for pickup, cancel preparation                              |
| `shipments:handover`          | active site, `WAREHOUSE` | confirm the hand-over to the carrier                                                                      |
| `shipments:resolve_uncertain` | active site, `WAREHOUSE` | the exceptional manual closing of an uncertain request (§3)                                               |
| `sites:carrier_manage`        | global (site detail)     | the site's carrier settings and "Ověřit připojení" (§9); security administration — never in a custom role |

Checked on every request, also on the repetition of the same request id; another site's order is
not found (404). Not warehouse-scoped (like orders, doc 028). `HOTEL_USER` stays unassignable.

## 7. UI

Order detail: hotel, number, site and delivery snapshot; **Další krok** with exactly one main action
for the current state or a truthful notice (no carrier and why, missing data, uncertain request
with the time from which it can be checked, carrier processing, cancellation running); the page
refreshes itself while the carrier may answer. **Balíky**: crate code, product, bottles, calculated
reference and its source, actual weighing (separately), package dimensions, carrier parcel number,
**each parcel's own label**, the complete document, the carrier's test-environment badge; collapsed
"Další možnosti" (cancel the preparation; the exceptional manual closing). Confirmations in dialogs
with an explicit check box. The hotel detail lists its orders with these statuses.

## 8. Implementation and tests

- Migrations `20261018090000_dispatch_enum_values`, `20261018090100_dispatch_shipments` (additive).
- API (`orders` module): `ShipmentsService`, `ShipmentCarrierFlow`, `ShipmentDeriver`,
  `ShipmentPoller`, `ShipmentsController`, carrier boundary and registry, the test-only carrier.
- `shipments.e2e.test.ts`: one and three crates, per-parcel labels mapped by the carrier's answer
  (answered in reverse order), missing weight, double click and concurrency, answers lost before and
  after the carrier, a hanging carrier cut off, asynchronous acceptance with polling continued by a
  second app instance ("restart"), a failed batch, the polling limit, labels downloaded later and
  checked before storing, the in-flight window in database time, the exceptional manual closing,
  cancellation recorded first / refused / lost / unsupported, concurrent cancel and hand-over, frozen
  content, `DISPATCHED`, no stock movement, database rules, W1 snapshots untouched, no carrier
  configured. `shipments-access.e2e.test.ts`: real sign-in, ADMIN only, per-step permissions incl.
  the exceptional one, permission removed before a replay, other site 404. Playwright
  `workflow-shipment.spec.ts`: the whole flow on a 390 px terminal incl. per-parcel labels;
  `workflow-dispatch.spec.ts`: mobile picking with the scanner focus.

## 9. Site carrier settings (PPL) and the server connection

**Správa systému → Provozovny → detail → Dopravci a expedice** (ADMIN only,
`sites:carrier_manage`; table `site_carrier_settings`, one row per site, never deleted, every change
audited without any secret):

- PPL only; "Používat PPL" switch; the **connection** is chosen by its server-side code (`PPL_TEST`,
  badge "Testovací prostředí"); its credentials are shown only as **nastaveno / nenastaveno**.
- Sender (name, street, city, postal code, country, contact, phone, e-mail) — may be prefilled from
  the site's address and must be checked by the user; PPL receives Latin characters only.
- Default service: only from the list read by **"Ověřit připojení"** with that connection (token +
  `GET /codelist/product`; creates no shipment and orders no pickup). No product, depot or other value
  is copied from examples.
- Labels: PDF or ZPL, printer resolution (default 203 dpi — Zebra ZD220), one label per parcel or
  additionally the complete A4 document. Labels are never cropped or scaled.
- Incomplete settings can be saved; what blocks new shipments is listed (and returned by the API).
  A changed connection needs a new verification.
- A new shipment request copies the settings and the connection (code + environment) into itself;
  later changes never affect it, and its polling, label download and cancellation use only its own
  connection — never another environment, never a fallback.

**Connections** are defined in code (`apps/api/src/carriers/ppl/ppl-connections.ts`): only
`PPL_TEST` → `https://api-dev.dhl.com/ecs/ppl/myapi2` exists. The URL is not editable by anyone; there
is no production connection, so DEV can neither switch nor fall back to production PPL. The API
refuses the PPL TEST credentials with `APP_ENV=production`; a different base URL is accepted only by
automated tests (`APP_ENV=test`).

**Credentials** (ADR 0027): entered in **Správa systému → Dopravci** (ADMIN,
`carriers:connections_manage`) — stored only AES-256-GCM-encrypted in `carrier_connections`, the
key (`CARRIER_CREDENTIALS_KEY`) only in the server env file; the secret is write-only (never
returned, logged, audited or kept in an idempotency record). Otherwise the server env file
(`PPL_TEST_CLIENT_ID` / `PPL_TEST_CLIENT_SECRET`, passed by `deploy/dev/compose.yml`) applies. The
UI shows only "nastaveno / nenastaveno" and the source. Every shipment and request records the
carrier **account** (a fingerprint of the client id): existing shipments are verified, polled and
cancelled only with that same account — credentials of another account never take them over.

On the DEV server, the owner authorized (2026-10-19) storing the PPL TEST credentials in
`/opt/ayvo/secrets/dev-preview.env` together with a generated `CARRIER_CREDENTIALS_KEY` (backup
kept, mode 600, no duplicate keys). They take effect only with an approved deploy.

**Tests:** `ppl.e2e.test.ts` runs the real adapter against a simulated PPL API
(`test/support/fake-ppl.ts`): settings saved incomplete and explained, verification (nothing
created), one and three crates (each number mapped by its own `CUST` reference, never by position),
unproven mapping, partly created set cancelled, lost `Location` and PPL unavailable (uncertain, never
re-sent), validation refusal, asynchronous processing with the poller, settings changed meanwhile
(snapshot kept), ZPL 203 dpi, labels only from the API origin (foreign host, redirect, oversized file
refused), disabled settings, other sites and environments, token reuse, no secret in any answer or
audit. `shipments-access.e2e.test.ts`: ADMIN only, other site separate. Playwright
`carrier-settings.spec.ts`: the page against the simulated PPL, no secret in the page, phone widths.
A run against the real PPL test environment (synthetic data, no pickup, no records in the live DEV
database) waits for the credentials.

## 10. Live run against the PPL TEST environment (2026-10-19, owner-authorized, once)

`apps/api/test/ppl-live.e2e.test.ts` — skipped unless `AYVO_PPL_LIVE=1` with the TEST credentials;
per-run test database (never the live DEV database), temporary file store, synthetic sender and
recipient, no pickup ordered (the adapter has no such call), nothing re-sent. Real API
`https://api-dev.dhl.com/ecs/ppl/myapi2`. Calls made: 1 token, 1 product list, 2 × `POST
shipment/batch` (201), 5 × batch status, 1 label download, 4 × cancel (202), `GET /shipment` for the
checks below. Results:

| Step                         | Result                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ověřit připojení             | OK — token, 16 products (incl. `BUSS` "PPL Parcel CZ Business", used for the test)                                                                                                                                                                                                                                                          |
| 1 crate                      | `201` + batch id → `ACCEPTED` → `Complete`: one number; label PDF **127 × 101 mm**, mapped (single parcel, its own `CUST`); re-download returned the same file, **no new batch**                                                                                                                                                            |
| 3 crates (set) + complete A4 | PPL created a set of 3 numbers (`shipmentSet`: master, `shipmentsInSet` 3, `shipmentInSetNumber` 1–3), but `GET /shipment` returns the **shipment's** `CUST` for all three, not each item's own → mapping **not proven** → `CARRIER_PARCEL_MISMATCH`, no label assigned (by design: never by position). Complete PDF therefore not reached. |
| Cancel (1 + 3 numbers)       | All 4 cancels answered `202`; within ~4 min per shipment (and ~8 min later) PPL still showed `Undelivered, DataShipment, Active` — **no `Canceled` seen**; both shipments stayed `CANCELLING` (correctly not assumed).                                                                                                                      |

Fixes from the run (simulator updated to the observed behaviour, regression tests): `shipmentState`
is a comma-separated set of flags — parsed as such; `Undelivered` (= not delivered yet) is not
"with the carrier". The synthetic TEST shipments 80256049251–80256049254 remain at PPL TEST with a
cancellation requested.

**Not verified:** labels of a multi-crate set and the complete A4 document against the real API
(blocked by the mapping question), a confirmed cancellation, physical printing (no printer).

**Later observation (2026-10-20, read-only; the run's results above stay as they were).** No new
shipment, no re-sent request — only a token and `GET` calls:

| Shipment                           | Cancel sent (run)       | Event `Deleted.Cancelled` (PPL track & trace) | `Canceled` visible through the API                                                                                                              |
| ---------------------------------- | ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 80256049251 (1 crate)              | 2026-10-19 19:39:54 UTC | 2026-10-19 19:39:55 UTC                       | **not** at 2026-10-19 19:48:06 UTC (`Undelivered, DataShipment, Active`); first seen 2026-10-20 12:14:41 UTC                                    |
| 80256049252–254 (set, master …252) | 2026-10-19 19:43:56 UTC | 2026-10-19 19:43:56 UTC                       | unknown during the run (the raw state was not recorded, and the code of the time compared it as one string); first seen 2026-10-20 12:14:17 UTC |

All four now read `Undelivered, DataShipment, Active, Canceled`. So PPL did cancel them, but the
event time is not when the API shows it: for …251 the flag was still absent 8 minutes after the
event. This is PPL's answer only — **our application's recovery and completion of a cancellation
(`CANCELLING` → confirmed, shipment back to `DRAFT`) against the real API is still not verified**: the run's two
shipments ended `CANCELLING`, their test database is gone, and nothing was re-run.

For PPL support (outside git, `/opt/ayvo/ppl-support/`): the original PDF labels of the set (individual
and the complete A4 document, re-downloaded unchanged), a **reconstruction** of the set's `POST
shipment/batch` body (the exact body sent was not kept — the run recorded only method, path and
status; regenerated by the unchanged `PplGateway.batch` from the same synthetic inputs) and the real
`GET shipment/batch/{id}` and `GET /shipment` answers, newly fetched on 2026-10-20.

**Evidence of later runs.** `ppl-live.e2e.test.ts` now requires `AYVO_PPL_LIVE_EXCHANGES`, a
directory outside any git worktree (refused otherwise; nothing is sent without it), and appends
every exchange to a JSON Lines file there (`test/support/ppl-exchange-log.ts`): the exact request
body as sent (and its SHA-256), the status, `Location` and the response body; a request is written
before its answer arrives, so an unanswered one is on record. Never recorded: the token request and
answer, the Authorization header, credential and token values (also scrubbed from every string — a
line that would still hold one is refused), phone numbers and e-mail addresses; label files only by
size and hash. The file is mode 600 and survives the per-run test database.

### 10a. Second live run — a set without the shipment-level `CUST` (2026-10-20, owner-authorized, once)

PPL support: the shipment-level `externalNumbers` overrides the items' own. The owner authorized
ONE 3-crate set with only that changed: `referenceId` kept, the shipment-level `CUST` left out
(the array omitted), the three item `CUST` references kept; everything else as in the first run
(BUSS, PDF, complete A4, the same synthetic sender and recipient). Scenario
`AYVO_PPL_LIVE_SCENARIO=set` (rehearsed first against the simulator with `AYVO_PPL_LIVE_DRYRUN=1`);
references never used at PPL before (`SHP-000101-1`). Verify (token + product list) created
nothing; no pickup ordered; nothing re-sent. The exact body sent and every answer are kept outside
git (`/opt/ayvo/ppl-support/2026-10-20-live-set-without-shipment-cust/`, exchange log as above).

| Crate        | `CUST` sent      | `CUST` returned by `GET /shipment` | PPL number  | Label (individual)                                   |
| ------------ | ---------------- | ---------------------------------- | ----------- | ---------------------------------------------------- |
| AYV-C-000001 | `SHP-000101-1-1` | `SHP-000101-1-1`                   | 80256049255 | PDF 127 × 101 mm; prints the number, 1/3 and its ref |
| AYV-C-000002 | `SHP-000101-1-2` | `SHP-000101-1-2`                   | 80256049256 | PDF 127 × 101 mm; prints the number, 2/3 and its ref |
| AYV-C-000003 | `SHP-000101-1-3` | `SHP-000101-1-3`                   | 80256049257 | PDF 127 × 101 mm; prints the number, 3/3 and its ref |

- Exactly three numbers (`shipmentSet`: master …255, `shipmentsInSet` 3); each returned its own
  `CUST`, so the adapter mapped every crate by its reference (no position used) → `LABELED`.
- The complete A4 document (one page, 297 × 210 mm, the three labels) from
  `shipment/batch/{id}/label`. It and every individual label were downloaded twice — identical,
  served from our store; **one** `POST shipment/batch` in total. Labels checked visually.
- Cancellation through the application: 3 × `POST /shipment/{n}/cancel` → `202` at 13:07:32 UTC;
  bounded `cancel/resolve` every 30 s: `CANCELLING` until `Canceled` was visible on all three, then
  the shipment was back to `DRAFT` at 13:17:41 UTC (~10 min). **This verifies our cancellation
  completion against the real TEST API** (not verified by the first run).
- The fix is in the adapter (`PplGateway.batch`): a set is sent without the shipment-level `CUST`.
  Regression: the simulator now applies a shipment-level `CUST` to every set parcel, as PPL does,
  and `ppl.e2e.test.ts` checks the body; the old code fails 3 tests there. One crate is unchanged
  (shipment-level `CUST`, covered by the simulated tests; not re-run live — not authorized).

**Still not verified:** physical printing (no printer); the production environment.

**Questions for PPL from the runs:** (1) answered (§10a): a shipment-level `CUST` overrides the
items' own; without it each set parcel returns its own — to be confirmed for production. (2) Cancellations are processed
in the TEST environment (see the later observation), but how long after the `Deleted.Cancelled`
event does `shipmentState` carry `Canceled` — in TEST and in production?
(3) Label size: the TEST label is 127 × 101 mm (CZ) — matches the e-mail, not the documentation's
127 × 110 mm.
