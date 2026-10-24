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

## 6. Open questions for the owner (not assumed)

1. Should FINANCE (planned role) get these permissions when it becomes assignable, and who else?
2. Which date decides the accounting period — issue date (implemented for N2) or DUZP?
3. Other file types (ISDOC/XML, e-mails)? Only PDF/JPEG/PNG now.
4. May Finance create suppliers itself (landlord, accountant)? Now only via Sklad → Dodavatelé.
5. ADR 0038 (runtime units, proposed): Finance is implemented as its own module with its own
   tables and only the supplier service as a dependency, so it can be moved to its own unit; it
   still runs in the current API process until that decision.
