# 039 — Finance: received documents (N1) and the accountant export (N2)

Status: implemented on branches for review (night 2026-10-24/25), **not merged, not deployed**.
Started by the owner ("tohle je tedy noční zadání… udělej co nejvíc"); scope from the night package
"Finance, doklady a hotelový portál" (N1, N2). The base proposal
`Portal-hotelu-a-finance-navrh-2026-10-24.md` was not available on the server; where it may decide
differently, §6 lists the question.

## 1. Purpose

Keep the originals of documents AYVO receives — rent, the accounting firm, services, material —
with the data the accountant needs, and hand them over per period (N2). This is **not**
bookkeeping: no VAT computation, no posting, no payment, no general ledger; the accounting stays
with the external accountant (UOL).

## 2. Model (N1) — tables `finance_documents`, `finance_document_events`

| Field                           | Meaning                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `code`                          | `FD-000001`, gapless (code counter `finance_document`)                                              |
| `supplier_id`                   | an existing supplier (the one supplier list of the company, managed in Sklad)                       |
| `kind`                          | `INVOICE`, `CREDIT_NOTE`, `ADVANCE_INVOICE`, `RECEIPT`, `OTHER`                                     |
| `document_number`, `issued_on`  | required, as on the document                                                                        |
| `tax_point_on` (DUZP), `due_on` | optional                                                                                            |
| `total_amount` + `currency`     | optional, both or neither, exactly as written (2 decimals; credit notes may be negative)            |
| `description`                   | optional, ≤ 500                                                                                     |
| file                            | `storage_key`, `sha256`, `byte_size`, `content_type` (PDF/JPEG/PNG by content), `original_filename` |
| `status`, `version`             | `ACTIVE`/`VOIDED`; every change is the next version                                                 |

Database rules (triggers): the original file and identity never change; a change of the current
state needs the next version **and** its event (checked at commit); a voided document never
changes; documents and events are never deleted; events are append-only. The same file cannot be
received twice while it is valid (unique SHA-256 among active documents).

Events: `RECEIVED` (snapshot), `CORRECTED` (full snapshot + reason), `VOIDED` (reason). The detail
shows each change as field: before → after.

## 3. API (company-wide, no site)

| Method | Path                                                                               | Permission                 |
| ------ | ---------------------------------------------------------------------------------- | -------------------------- |
| GET    | `/api/admin/finance/suppliers`                                                     | `finance:documents_manage` |
| GET    | `/api/admin/finance/documents?q&supplierId&status&issuedFrom&issuedTo&page`        | `finance:documents_read`   |
| POST   | `/api/admin/finance/documents` (multipart: fields + `file`)                        | `finance:documents_manage` |
| GET    | `/api/admin/finance/documents/:code`                                               | `finance:documents_read`   |
| GET    | `/api/admin/finance/documents/:code/content` (attachment, nosniff, CSP sandbox)    | `finance:documents_read`   |
| POST   | `/api/admin/finance/documents/:code/correct` (`expectedVersion`, `reason`, fields) | `finance:documents_manage` |
| POST   | `/api/admin/finance/documents/:code/void` (`expectedVersion`, `reason`)            | `finance:documents_manage` |

Upload limit: the existing `SUPPLIER_DOCUMENT_MAX_BYTES`. Idempotency: the upload by its
`requestId` (same request → same document; same id, other file → 409); corrections and voiding by
`expectedVersion` (409 `STALE_VERSION`). Storage: the existing `FileStorage`, namespace
`finance-documents` (local on DEV, private S3 on PROD — no bucket policy change).

## 4. Permissions and roles

`finance:documents_read`, `finance:documents_manage` — granted to **ADMIN only** by the migration.
`FINANCE` stays a planned (non-assignable) role; no live assignment was changed.

## 5. UI

Finance → Přijaté doklady (`/finance/documents`): receive (file + metadata), search/filters,
table (desktop) / cards (phone); detail with the original's download, history, correction and
voiding with a reason. Screenshots: `docs/screenshots/finance/`.

## 7. Export for the accountant (N2) — `accounting_exports`, `accounting_export_items`

A fixed package for a period of **issue dates** (≤ 366 days): ZIP with `manifest.csv` (UTF-8 with
BOM, `;`, CRLF; CSV-injection protected), `README.txt` and `doklady/<code>-<name>` — the unchanged
originals (SHA-256 re-checked while packing). Built without a new dependency (`finance/zip.ts`,
STORE). Stored in `FileStorage` (`accounting-exports`) and downloadable again unchanged.

- **FULL** — every valid document of the period; each line says `NEW` (first handed over),
  `CHANGED` (metadata changed since handed over), `INCLUDED` (already handed over, unchanged);
  voided documents that were handed over before are listed once as `VOIDED` (without the file).
- **SUPPLEMENT** — only `NEW`, `CHANGED` and `VOIDED` since the earlier exports.
- Each export records the exact **document version** handed over (FK to that version's event);
  the export shows its lines with the metadata of that version, and separately what in its period
  changed afterwards ("Změněno po exportu"). Records are append-only (DB triggers).
- Bounds: ≤ 1000 documents and ≤ 200 MiB per export (else 422; preview says so). Creation is
  serialised (advisory lock) and idempotent per `requestId`. Preview writes nothing.
- Permission `finance:exports_manage` (create, ADMIN only); history and downloads need
  `finance:documents_read`.

API: `GET /finance/exports`, `GET /finance/exports/preview?periodFrom&periodTo&mode`,
`POST /finance/exports`, `GET /finance/exports/:code`, `GET /finance/exports/:code/content` (ZIP).
UI: Finance → Export pro účetní.

## 6. Open questions for the owner (not assumed)

1. Should FINANCE (planned role) get these permissions when it becomes assignable, and who else?
2. Which date decides the accounting period — issue date (implemented for N2) or DUZP? Should an
   export be marked as received by the accountant, or sent to them (it is only downloaded now)?
3. Other file types (ISDOC/XML, e-mails)? Only PDF/JPEG/PNG now.
4. May Finance create suppliers itself (landlord, accountant)? Now only via Sklad → Dodavatelé.
5. ADR 0038 (runtime units, proposed): Finance is implemented as its own module with its own
   tables and only the supplier service as a dependency, so it can be moved to its own unit; it
   still runs in the current API process until that decision.
