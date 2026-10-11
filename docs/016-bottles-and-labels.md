# 016 — Bottles, Label Templates and Label Printing (Milestone 1)

Registering physical reusable bottles and producing their printed labels. Columns and
constraints: [data dictionary](015-data-dictionary.md).

Status: **DEV implementation only** (branch `feat/bottle-labels-v0.1`, 2026-10-10). Not approved
for production deployment or real bottle labels — see [Production blockers](#production-blockers).

How to read this document:

- **Implemented (DEV)** — what the code does today.
- **Accepted** — owner-confirmed decisions (ADR 0014 token/URLs/safeguards, ADR 0015 versions,
  ADR 0016 storage abstraction for DEV).
- **Provisional** — physical-print assumptions awaiting the print/scan test (QR size, EC level,
  printer output).
- **Production blockers** and **Deferred** — the two lists at the end.

## Requirements (owner, 2026-10-10)

- An administrator creates a reusable **label template** (e.g. `mydlo1`): physical size in mm,
  uploaded background artwork, and a QR code positioned and resized **visually** on the artwork.
- The administrator registers **1–1000 physical bottles** with a template. AYVO OS atomically
  creates one creation batch, the bottles, their codes, opaque public QR tokens and one `CREATED`
  event each — all or nothing.
- A **print job** renders one print-ready **PDF, one label per page** at the template's exact
  physical size (no bleed, no crop marks, print at 100 %), same artwork on every page, a
  different vector QR code per bottle at exactly the designed position. No A4 imposition.
- PDF rendering is **outside** the creation transaction; a failed rendering never touches
  bottles; a retry renders the same bottles again.
- Template versions are **immutable**; historical batches and print jobs always use their
  recorded version.
- QR content is **only** the public URL: production `https://qr.ayvo.co/<token>`, DEV
  `https://dev.ayvo.co/q/<token>` ([ADR 0014](adr/0014-public-qr-identity-and-url.md)).
- Minimal **public bottle passport** by token only. Out of scope: products, fill batches, crates,
  hotels, deliveries, returns, washing, QC, carriers, billing, ESG, final authentication.

## Concepts — do not confuse

| Concept                  | What it is                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Bottle**               | Permanent identity of one reusable bottle body; physical once its label is applied (doc 018). Never deleted. |
| **BottleEvent**          | Append-only lifecycle history entry. Milestone 1: `CREATED` only.                                            |
| **BottleCreationBatch**  | Bottles registered together in one operation (`BC-000001`). **Not** a fill batch.                            |
| **LabelTemplate**        | Reusable logical label design, e.g. `mydlo1`. **Not** a product. Can be archived.                            |
| **LabelTemplateVersion** | Immutable snapshot of a design: size, artwork, element positions (`mydlo1 v1`).                              |
| **LabelTemplateElement** | One positioned element of a version. Implemented: `QR_CODE` only.                                            |
| **LabelArtwork**         | Uploaded background (SVG/PNG/JPEG); bytes in file storage, metadata in PostgreSQL.                           |
| **LabelPrintJob**        | One rendering of a fixed set of bottles with a fixed version (`PJ-000001`).                                  |

## Module structure: reusable label engine vs. bottle orchestration

```
labels (reusable label engine)  ◄──  assets (bottles)  ◄──  label-production (bottle workflow)
```

- **`labels` — reusable, knows nothing about bottles:** label dimensions and the mm coordinate
  system; immutable template versions; layout elements; artwork validation and references; QR
  geometry and quiet-zone rules; the PDF renderer (`LabelPdfRenderer`, input = layout + plain
  `{ code, url }` labels + EC level + DEV marker); calibration and QR validation documents. Uses
  only `FileStorage` and the shared QR environment policy (`common/qr-policy.ts`).
- **`assets` — bottle-specific:** bottles, codes, public tokens, `CREATED` events, creation
  batches, the public passport. Uses `labels` only through `LabelTemplatesService`.
- **`label-production` — bottle-specific orchestration:** the registration workflow and bottle
  print jobs (job items reference bottles). Uses `BottlesService`, `LabelTemplatesService` and
  `LabelPdfRenderer`.
- Cross-module **foreign keys** exist for integrity only; no module queries another module's
  tables. Shared contracts (DTOs, layout geometry, `qrGeometry`, QR quiet zone, EC levels) live in
  `packages/types`; the browser preview and the PDF renderer both use them.
- **Extension points (not implemented):** a crate or shipping-label workflow would add its own
  orchestration module and job/item tables and reuse `labels` (templates, renderer, calibration).
  A new element type (e.g. `BOTTLE_CODE`, `TEXT`) = a new enum value + a discriminated Zod schema
  branch + a renderer/preview branch; existing `QR_CODE` rows stay untouched. No generic "asset
  workflow" exists until a second real one does.

## Identities of a bottle

| Identity     | Example                                     | Purpose                                               | Public?   |
| ------------ | ------------------------------------------- | ----------------------------------------------------- | --------- |
| Internal ID  | `01960d1e-…` (UUIDv7)                       | Primary key; every reference uses it                  | **No**    |
| Bottle code  | `AYV-B-000001`                              | Human-readable, sequential; operators, lists          | Displayed |
| Public token | `3kx8-qNyvC3jLz2HTWhiZw` (22 chars)         | Opaque public QR identity, 128 CSPRNG bits (ADR 0014) | In the QR |
| QR URL       | `https://qr.ayvo.co/3kx8-qNyvC3jLz2HTWhiZw` | The only content of the QR code                       | Yes       |

All four are immutable. The code is **not** a security boundary: public lookup works only with
the token. Each print job stores the exact QR URL of every label.

## Bottle registration (implemented)

`POST /api/admin/bottle-registrations { requestId, labelTemplateVersionId, quantity }`.

- **Idempotent:** `requestId` is a client-generated UUID (the UI creates one per confirmation and
  reuses it for retries). A repeated request returns the original batch and its print job
  (`replayed: true`); reusing the id with different input → 409. Concurrent duplicates create one
  batch (unique `client_request_id`).
- **One transaction:** re-check that the version is the **latest version of an active template**
  under a share lock on the template row (archive / new version wait); allocate the batch serial
  and N bottle serials; insert the batch, N bottles (fresh tokens) and N `CREATED` events. Any
  failure rolls everything back, including the counters.
- Then, separately, a **PENDING print job** for exactly those bottles. If that step fails, the
  bottles stay registered; a print job can be created from the batch page.

### Numbering and concurrency

- `AYV-B-` / `BC-` / `PJ-` + serial zero-padded to 6 digits, growing beyond (`AYV-B-1000000`); a
  CHECK keeps code and serial consistent (`ayvo_format_code`).
- Counters are rows in `code_counters`, incremented with `UPDATE … RETURNING` inside the business
  transaction: the row lock serialises registrations, so each batch gets one **contiguous,
  gapless** range; a rolled-back transaction consumes nothing. Fixed lock order (template share
  lock → batch counter → bottle counter) rules out deadlocks.
- **Trade-off:** registrations run one at a time (tens of ms per 100 bottles). Fine for an admin
  workflow; distributed counters are not planned.

## Label templates (implemented)

- Creating a template creates **v1**. Saving a changed layout (artwork, size, element position or
  size) creates **v(n+1)**; an identical layout creates nothing. Versions, elements and artwork
  are immutable (DB triggers) — see [ADR 0015](adr/0015-immutable-label-template-versions.md).
- **Archive / restore:** archived templates keep every version for historical reproduction, are
  hidden from bottle creation (UI) and refused by the API for new batches, and cannot get new
  versions. Templates and versions are never deleted.
- **Renaming is disabled.** Prerequisites before it can be allowed: (1) historical references
  (batch and print-job displays, PDF filenames, "mydlo1 v1") are derived from the current template
  name — a per-version name snapshot is needed so a rename never relabels history; (2) a rename is
  an administrative change that needs an actor and an audit entry (ADR 0006 audit log, ADR 0017
  identity) — neither exists yet.

### Layout coordinates

- Millimetres with two decimals (0.01 mm); label size 10–500 mm per side.
- Origin **top-left** of the label, x right, y **down**. The PDF renderer converts to points
  (1 mm = 72/25.4 pt) and flips y.
- Element box `xMm, yMm, widthMm, heightMm, rotationDeg`. A `QR_CODE` box **includes the 4-module
  quiet zone**, is square, lies on the label, has `rotationDeg = 0`, and is ≥
  `LABEL_QR_MIN_SIZE_MM` (**provisional**). Enforced by the Zod contract, the service and the DB.
- `qrGeometry` (packages/types) defines where the symbol sits inside the box; the browser preview
  and the PDF renderer both use it, and tests compare each against it.

### Artwork

- Upload `POST /api/admin/label-artworks` (multipart `file`), limit `LABEL_ARTWORK_MAX_BYTES`
  (413). Type from **content**, never filename or client MIME. PNG/JPEG headers parsed and capped
  (12 000 px/side, 100 MP), then decoded with the renderer's library. SVG must be self-contained
  static art (no scripts, handlers, `foreignObject`, DOCTYPE/entities, external references);
  text should be outlined. The artwork fills the label; proportions must match within 1 %.
- Served to admins with `nosniff` and a sandboxing CSP. Storage keys are server-generated.

### Designer (web)

Drag to move, corner handles to resize (square, opposite corner fixed), mouse/pen/touch via
pointer events, arrow keys (0.1 mm; Shift 1 mm), visible focus, labelled X / Y / Width / Height
fields in mm. Pixels exist only on screen (`label-geometry.ts`, round-trip tested). The QR
preview uses the API's configured preview URL and EC level — never a frontend constant.

## Print jobs (implemented)

- Job items fix the bottles, page order and the **exact QR URL** per label (DB trigger: URL =
  job base URL + `/` + token). The job fixes template version, label count, base URL,
  **environment** and **EC level** (immutable columns).
- `POST …/label-print-jobs/:code/generate` claims the job atomically (`PENDING` / `FAILED` /
  abandoned `GENERATING` → `GENERATING`, attempts + 1). Every later write is conditional on that
  claim, so a superseded attempt can never overwrite a newer outcome.
- Order: render → store the PDF → mark `COMPLETED`. A job is never `COMPLETED` without its stored
  file. Failures → `FAILED` with a fixed safe message (details only in the server log).
- **Recovery:** a job stuck in `GENERATING` (crash, failed final write) becomes reclaimable after
  10 minutes; a retry renders the same items. A file stored by a superseded or failed-to-record
  attempt is an unreferenced orphan, logged with its key; harmless, sweepable later.
- A `COMPLETED` job is not regenerated; reprints are new jobs for the same bottles.

### PDF output

- **pdf-lib**; SVG artwork → one-page vector PDF (PDFKit + svg-to-pdfkit), embedded once and
  reused on every page (≈ 3 kB per extra page; 1000 labels ≈ 3 s, 2.2 MB).
- One page per label at the exact template size; no bleed or crop marks; print at 100 %.
- QR in device-independent solid black (DeviceGray 0) on an opaque white square (DeviceGray 1)
  covering the whole box. **Provisional:** whether the printer workflow outputs pure K black is
  unverified.
- Non-production jobs print a red `DEV - NOT FOR PRODUCTION` band under the QR on every label.

## DEV / production QR separation (implemented, accepted)

See [ADR 0014](adr/0014-public-qr-identity-and-url.md). Production encodes only
`https://qr.ayvo.co`; development and test never encode the `qr.ayvo.co` host (any case, port,
userinfo, trailing dot or subdomain). Enforced at startup, at job creation, at rendering and by a
database CHECK on the parsed host. Designer previews use the configured base URL.

## Calibration and QR validation (implemented; provisional values)

- `GET /api/admin/label-calibration/qr-validation-sheet.pdf` — A4: 10/12/15/18 mm × EC M/Q with
  full quiet zones, each labelled with module count and module size (15 mm/Q marked provisional
  candidate), a 10 mm bar, a 100 mm ruler, page size, the scaling warning and the scan-test
  checklist. Test URLs: `https://qr.invalid/<22 chars>` (production length, never resolves).
- `GET /api/admin/label-template-versions/:id/calibration.pdf` — one page at the version's exact
  size with the QR at its position, page dimensions, 10 mm reference, scaling warning, DEV marker.
- **Reproducible artifacts:** `pnpm label-artifacts` builds the API and writes
  `artifacts/label-review/` (both PDFs, a DEV sample label, PNG previews, and `verification.txt`
  after decoding every QR; exits non-zero on any mismatch). Options: `--out DIR`,
  `--api URL --template-version ID` (calibration of a version from a running local API). The
  generated files are git-ignored.

## Public passport (implemented)

`GET /api/public/bottles/:token` → `{ bottleCode, reuseCycles }` (strict public DTO); web
`/q/<token>`. Malformed or unknown token → 404; never by code or internal ID. `reuseCycles`
follows ADR 0011 (always 0 until delivery/sorting events exist). No CO2e, hotel, batch or
operator data. `Cache-Control: public, max-age=60`. **Rate limiting: not implemented** — see
blockers.

## File storage (DEV only)

`FileStorage` interface (`put`/`get`, deliberately no `delete`); `LocalFileStorage` on the volume
`ayvo-dev-preview-files-data`. Server-generated keys, traversal-proof paths, atomic writes, no
overwrite, temp files always removed. Missing files → stable 404 "The stored file is not
available". Production refuses to start with local storage
([ADR 0016](adr/0016-file-storage-abstraction.md)). **`pg_dump` does not back up these files.**

## Admin UI: one Bottles module

Bottles and creation batches stay separate in the database and API (a bottle is one physical
item; a creation batch is the auditable record of one bulk registration), but the admin UI shows
them as **one module, "Bottles"** (2026-10-11):

- `/bottles` (default view) — the individual bottles, with search and filters;
  `/bottles/history` — **Creation history**: one row per creation ("series") with its date,
  quantity, code range, label template and the state of its latest print job
  (`GET /api/admin/bottle-creation-history`, composed in label-production from the assets batch
  list; a fixed number of queries per page, never one per row). The creator is not recorded
  until authentication exists (ADR 0017).
- `/bottles/new` — **Create bottles**: number of bottles → label template → review (expected code
  range, template, this environment's QR URL and the DEV marker) → confirm once → result with
  the created codes, a link to the created bottles and the labels (print job). The idempotency key
  is created at review and kept in `sessionStorage` until the result is shown, so a retry, a
  double click or a reload during creation never registers bottles twice.
- `/batches/[code]` — detail of one creation (series) with its print jobs; kept for deep links.
  `/batches` is a real HTTP 307 redirect to `/bottles/history` (`next.config.ts`, query kept).
- Unknown or malformed bottle, series and template ids answer a real HTTP 404 with the
  not-found page. Detail pages therefore have no `loading.tsx` above them (a loading boundary
  streams the response with status 200 before the page can decide); list and create pages keep
  their loading skeleton through route groups.
- The bottle detail shows status, reuse cycles, creation date, the originating series (secondary
  link), the lifecycle and the QR code with an "Open passport" action. No current location yet
  (no location model).

## API overview

| Method | Path                                                       | Module           |
| ------ | ---------------------------------------------------------- | ---------------- |
| GET    | `/api/admin/label-designer/settings`                       | labels           |
| POST   | `/api/admin/label-artworks`                                | labels           |
| GET    | `/api/admin/label-artworks/:id/content`                    | labels           |
| GET    | `/api/admin/label-templates`                               | labels           |
| POST   | `/api/admin/label-templates`                               | labels           |
| GET    | `/api/admin/label-templates/:id`                           | labels           |
| POST   | `/api/admin/label-templates/:id/versions`                  | labels           |
| POST   | `/api/admin/label-templates/:id/archive` · `/restore`      | labels           |
| GET    | `/api/admin/label-template-versions/:id`                   | labels           |
| GET    | `/api/admin/label-template-versions/:id/calibration.pdf`   | labels           |
| GET    | `/api/admin/label-calibration/qr-validation-sheet.pdf`     | labels           |
| GET    | `/api/admin/bottles?page&pageSize&search&batch&templateId` | assets           |
| GET    | `/api/admin/bottles/:code`                                 | assets           |
| GET    | `/api/admin/bottle-batches`                                | assets           |
| GET    | `/api/admin/bottle-batches/:code`                          | assets           |
| GET    | `/api/public/bottles/:token`                               | assets (public)  |
| POST   | `/api/admin/bottle-registrations`                          | label-production |
| GET    | `/api/admin/bottle-batches/:code/print-jobs`               | label-production |
| POST   | `/api/admin/bottle-batches/:code/print-jobs`               | label-production |
| GET    | `/api/admin/bottle-creation-history?page&pageSize`         | label-production |
| GET    | `/api/admin/label-print-jobs/:code`                        | label-production |
| POST   | `/api/admin/label-print-jobs/:code/generate`               | label-production |
| GET    | `/api/admin/label-print-jobs/:code/pdf`                    | label-production |

Requests and responses are Zod contracts in `packages/types`; route params and queries are
validated (400 with field messages); responses are explicit DTOs.

## Owner decisions (2026-10-10)

- Timestamps in UTC, displayed in `Europe/Prague`.
- New batches only with the latest active template version; historical jobs keep their version.
- Template archiving; no deletion of referenced templates/versions.
- Token format and DEV/production URL formats approved (ADR 0014).
- Basic Auth acceptable only for the isolated DEV environment.

## Production blockers

This is the single consolidated list (other documents link here).

1. **Physical QR testing** — print the validation sheet; test after printing, on the curved
   bottle, warehouse and hotel light, wet, after repeated washing, modern and older phones.
2. **QR size and error-correction approval** — record in ADR 0014; set `LABEL_QR_MIN_SIZE_MM` and
   `LABEL_QR_ERROR_CORRECTION` in production (startup refuses without them).
3. **Printer verification** — printer model, DPI, label material, adhesive, washing conditions,
   print driver (100 % scale, exact size, black output).
4. **`qr.ayvo.co` DNS and routing** of `/<token>` to the passport.
5. **Application authentication** — implemented (Milestone 2C, doc 021: WorkOS AuthKit behind a
   provider boundary, AYVO sessions); still a blocker until activated and verified with real
   WorkOS environments and until the pricing, DPA and EU data-location check is done.
6. **Authorization and role model** — implemented (doc 021: deny-by-default guard on every route,
   roles, permissions, warehouse scopes, audit); hotel organization/site scopes follow with the
   hotel modules.
7. **Rate limiting** — public passport, authentication and mutation endpoints. Not implemented:
   it needs a decision on how client identity crosses the proxy chain (Caddy → Next.js SSR → API:
   which forwarded headers are trusted), the public QR host topology, limits and fail-open policy.
   Redis (already approved, ADR 0010) is the intended store.
8. **Production object-storage provider** — S3-compatible `FileStorage`, versioning / object lock.
9. **Files backup and restore procedure** — off-site, retention, together with the database.
10. **Real restore test** before production approval.
11. **Monitoring and alerting** (doc 013).
12. **Production secrets and rotation procedure** (doc 012).
13. **Durable secondary identity on the bottle body** (doc 018 §17) — a permanent small
    QR/DataMatrix or durable human-readable code resolving to the same identity, chosen and
    physically validated. Until then an unidentified returned bottle goes to quarantine and is never
    matched by guessing.

## Deferred (not blockers for DEV)

- PDF artwork backgrounds and their browser preview (no pdf.js for this now).
- Template renaming (prerequisites above); selecting older versions for new batches.
- Additional element types (`BOTTLE_CODE`, `TEXT`, `BARCODE`, `BATCH_CODE`), rotation, A4
  imposition, bleed/crop marks.
- Orphan-file sweep; idempotency keys for manual reprint jobs (the UI prevents double submits).
