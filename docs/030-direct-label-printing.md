# 030 — Dispatch in one action: PDF and ZPL labels, direct printing on a Zebra

Status (2026-10-20): PR C, follows PR #36 (dispatch) and PR #37 (PPL). Implemented and tested
against a simulated PPL and a simulated print agent. **Not verified physically** (no Raspberry Pi
and no Zebra were available — §9). Architecture: ADR 0028.

## 1. The operator's flow (owner 2026-10-20)

Everything stays on the order in **Expedice** (doc 029 §1):

1. Open the hotel's order; scan the finished full crates (each crate brings its bottles and cycles).
2. When the order is exactly fulfilled: **„Dokončit a vytisknout N štítků“** (the button names the
   target printer) — completes the picking, creates the shipment at the carrier (once, doc 029 §3),
   fetches the labels and puts them into the print queue of that printer. The phone stays on the
   picking screen ("Kompletace dokončena", the result, a link to the order). Offered only to users
   with `shipments:prepare` at a site with a carrier; without `printing:print` or without an
   automatic dispatch printer it reads „Dokončit a připravit štítky“ and prints nothing. If a later
   step fails (e.g. the carrier needs a weight that is not known), the picking stays completed and
   the order shows the next step.
3. The Raspberry Pi agent takes the jobs and sends the carrier's own ZPL to the Zebra.
4. The operator applies the labels and confirms **„Připraveno k vyzvednutí“**; the hand-over to the
   carrier is confirmed separately later (**„Předáno dopravci“**).

No extra bottle scanning, no manual shipment, no format choice per order, weighing stays optional.
One crate = one parcel = one label, mapped by verified references (never by position). Dispatch
moves no stock. A downloaded file, an accepted job or a job sent to the printer never confirms an
applied label; hand-over to the carrier is not delivery.

## 2. Two formats of the same labels

- The carrier request asks for **PDF** (with the complete A4 document when the site wants it):
  preview and download. The shipment is `LABELED` as soon as every parcel has its PDF (as before).
- Then the **ZPL** of the same parcels at the printer's resolution (the site's default dispatch
  printer; 203 dpi without one — the only supported device) is fetched from the **same** batch with
  PPL's documented format change: `PUT shipment/batch/{batchId}` with `labelSettings`
  (`format: Zpl`, `dpi`) → `GET shipment/batch/{batchId}` until every parcel's `labelUrl` carries a
  **new** data GUID (PPL changes it on every PUT; its label cache is 60 s, `data` 1 s) → `GET
data/{guid}` per parcel. No second shipment, same numbers; our own conversion of PDF to ZPL or
  redrawing a label never happens.
- **Variants are stored side by side** (`shipment_labels`: one row per parcel, format and dpi, plus
  the carrier's file reference). Files are never replaced or deleted; a new variant is a new row.
  Each variant row is tied to its parcel (and through it its crate and number).
- **One fetch at a time per shipment** (a lease): the batch's format at PPL is shared state, so
  two fetches never interleave. Preview, download and printing only read stored files and never
  touch PPL.
- **An outage between PDF and ZPL** leaves the order usable (PDF preview and download); the ZPL
  fetch is retried in the background (bounded, back-off) and on "Získat ZPL znovu"; until it
  arrives, printing waits and the order says so.
- **Checks:** each ZPL file starts with `^XA`, is at most 5 MB and comes from the parcel's own
  `labelUrl` of the batch status (mapped by shipment number, proven at creation).

## 3. Printers per site (Správa systému → Provozovny → detail → Tiskárny)

Separate from the carrier settings — a carrier account is not a printer. A printer: name, model
(**Zebra ZD220 DT**, the only supported model: ZPL, 203 dpi, USB), the print agent it is attached
to (with the printer's USB serial number), default for dispatch (at most one per site), automatic
printing on/off, enabled/archived, last reported availability. Media size is **not** stored or
assumed (unknown until the physical test); labels are sent exactly as PPL made them, never scaled
or cropped. ADMIN only (`printing:manage`, security administration).

Print agents: created per site by ADMIN; the token is shown once (only its hash is stored),
rotated or revoked; the agent's last contact and reported printer state are shown.

## 4. The print queue (ADR 0028)

- One job per parcel label: order, shipment, parcel, stored ZPL variant, printer and agent — fixed
  at creation. The job's history is append-only (`print_job_events`).
- States: `QUEUED` (waiting) → `CLAIMED` (taken by the agent) → `SENDING` (the server allowed the
  write) → `SENT` (all bytes written to the device) | `FAILED` (proven not sent) | `UNCERTAIN`
  (possibly sent, result unknown); `CANCELLED` (before sending). An expired claim that never started
  returns to `QUEUED`; a started job without a result becomes `UNCERTAIN` and is never retried
  automatically.
- Printing a shipment's labels happens automatically after "Dokončit a vytisknout štítky" when the
  site has an enabled default dispatch printer with automatic printing and the user may print
  (`printing:print`); otherwise "Tisknout štítky" does it explicitly. The target and the number of
  labels are shown before.
- **Re-print** one parcel (`printing:reprint`): a new job with the same stored label, a reason, and —
  after an earlier `SENT`/`UNCERTAIN` job of that parcel — an explicit acknowledgement that a second
  physical label may appear. Never for the whole shipment at once; never creates anything at PPL.
- **Cancelling the shipment** cancels its waiting jobs at once (recorded with the cancellation);
  `start` is refused for a job whose shipment is no longer `LABELED`. Labels that may physically
  exist (`SENT`/`UNCERTAIN`) are listed with the instruction to remove or destroy them. A new
  preparation uses its new labels only.

## 5. Agent protocol (`/api/agent/v1`, header `X-Ayvo-Print-Agent`)

`POST heartbeat` (version, printers' state) · `POST jobs/claim` (the next job of its printers,
lease 60 s) · `GET jobs/{id}/data?claim=…` (the stored ZPL, only while claimed by it) · `POST
jobs/{id}/start` · `POST jobs/{id}/result` (`SENT` | `FAILED_BEFORE_SEND` | `UNCERTAIN`, detail).
Each call is idempotent per claim token. The agent identifies the printer by USB serial number
(`/sys/class/usbmisc/lp*`), writes only the job's bytes, and keeps a local journal
(`claimed → writing → written`) to report truthfully after a restart.

## 6. Permissions (ADMIN only for now)

`printing:print` (print a shipment's labels, incl. the automatic print of the combined action),
`printing:reprint`, `printing:manage` (printers and agents; security administration). The combined
action requires `orders:pick` **and** `shipments:prepare`; printing in it additionally
`printing:print` — without it the labels are prepared and the order says that printing was not
started. All checked on the server, per site.

## 7. UI

The order detail shows one next step, the carrier state, the number of labels, the target printer,
the queue (per parcel), PDF previews and files (PDF; ZPL with `printing:print`), and "Vytisknout
znovu" per parcel. Problems of the carrier, printer or agent are shown as they are; the order stays
findable in its tab with the next step.

## 8. Tests (automated, no real PPL, no printer)

API: three crates → three PDF + three ZPL with the same numbers; the format change creates no new
shipment; double click and lost answer of the combined action; PPL down between PDF and ZPL;
agent offline / printer missing / agent restart; lost result after a possible write (`UNCERTAIN`,
no retry); two agents claiming one job; re-print of one label only; cancellation stops waiting
jobs; default printer changed during printing; another site, removed permission; no stock movement.
Simulated PPL (`test/support/fake-ppl.ts`) implements the documented PUT and GUID change. The agent
(`ops/print-agent`) has its own unit tests with a fake device.

## 9. Not verified / open

- **Physical printing** on a Zebra ZD220 DT via a Raspberry Pi: no device was available on
  2026-10-20 (none on the tailnet). Install guide: `ops/print-agent/README.md`.
- Media size, darkness and print speed of the real labels; whether PPL's ZPL fits the medium
  without changes (never scaled by us).
- PPL: how long after `PUT` the new GUIDs appear in production; whether the ZPL `data` call is
  rate-limited.
- **PPL: the set position after a format change (open, asked).** On the TEST batch
  `8016c3fb-8be4-467b-bba9-5cfc4facd59f` (set 80256049255–257, created 2026-10-20 13:07 UTC, already
  **cancelled** since 13:17 UTC) the `PUT` format change at 14:45 UTC produced for the third parcel
  80256049257 (`shipmentInSetNumber` 3 of 3 in `GET /shipment`, Ref. SHP-000101-1-3) a ZPL and a
  regenerated PDF printing **"1/1"** — the original PDF of the same parcel (data GUID `994cb04e…`,
  still served unchanged) prints "3/3"; parcels 1 and 2 stay 1/3 and 2/3. Checked: the same number
  and reference, the current GUID (`203f9801…`, stable on re-download — not a stale cache). Cause
  unknown (not presumed PPL's or ours); not tried on a set that is not cancelled (no new shipment
  without the owner's consent). Evidence and the question for PPL:
  `/opt/ayvo/ppl-support/2026-10-20-format-change/README-1z1.txt`. **The adapter refuses such a
  ZPL** (`LABEL_VARIANT_MISMATCH`: number, own reference and, in a set, the position n/N must all
  match — a real single parcel's 1/1 is correct), so it is never printed automatically and never
  corrected by us; the PDF stays available and „Získat ZPL znovu“ tries again.
