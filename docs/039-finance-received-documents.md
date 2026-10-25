# 039 — Finance: received documents (N1) and the accountant export (N2)

Status: implemented on branches for review, **not merged, not deployed**. Night 2026-10-24/25
started by the owner; reworked 2026-10-25 after the independent review (REVIEW-N1-N2-20261025)
and the owner's decision on the runtime boundary (ADR 0039, limited variant A). Source: the night
package N1/N2 and `Portal-hotelu-a-finance-navrh-2026-10-24.md` §6a/§6b.

## 1. Purpose

Keep the originals of documents AYVO receives — rent, the accounting firm, services, material —
with the data the accountant needs, and hand them over per period (N2). This is **not**
bookkeeping: no VAT computation, no posting, no payment, no general ledger; the accounting stays
with the external accountant (UOL).

## 2. Runtime (ADR 0039)

Finance is its own unit: container `finance` (`node dist/finance/main.js`, the API image with its
own release tag), schema `finance` (own Prisma schema and migrations, `apps/api/prisma-finance`),
login roles `ayvo_finance_owner` (owns the schema, runs migrations) and `ayvo_finance` (runtime:
SELECT/INSERT/UPDATE on Finance tables only, no DELETE/TRUNCATE/DDL, no right on `public`). No
foreign keys to the core: supplier, supplier document, site and user are ids + the names as of
the event. Suppliers, supplier documents and the user come only from the core contract
`/api/internal/v1/finance/*` (service token + the user's forwarded session; the core evaluates
the session, permissions, sites and CSRF on every request; Caddy aborts `/api/internal/*`).
Core unavailable → Finance answers 503 `FINANCE_DEPENDENCY_UNAVAILABLE` (never access); Finance
down → only `/api/admin/finance/*` and the Finance pages are unavailable. The Finance pages stay
in the shared web app (ADR 0039 §5). Deployment: `scripts/deploy-finance-dev.sh` (DEV only so far).

## 3. Model (N1) — `finance.documents`, `finance.document_events`

| Field                                   | Meaning                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `code`                                  | `FD-000001`, gapless (`finance.code_counters`)                                                                  |
| `supplier_id` + `supplier_name`         | a core supplier (id + name as of this version); may be missing in a draft                                       |
| `kind`                                  | `INVOICE`, `CREDIT_NOTE`, `ADVANCE_INVOICE`, `RECEIPT`, `OTHER` — the only required metadata                    |
| `document_number`, `issued_on`          | as on the document; may be missing in a draft                                                                   |
| `tax_point_on` (DUZP), `due_on`         | optional                                                                                                        |
| `total_amount` + `currency`             | optional, both or neither, exactly as written                                                                   |
| `handover_month`                        | the month whose export the document belongs to (organisational, not a tax date); may be missing in a draft      |
| `source`                                | `UPLOAD` (own PDF, stored by Finance) or `SUPPLIER_DOCUMENT` (a referenced supplier document of Sklad, no copy) |
| `supplier_document_id`, `source_site_*` | the referenced supplier document and its site (kept; access is re-checked by the core on every read)            |
| file                                    | `sha256`, `byte_size`, `content_type`, `original_filename`; `storage_key` only for `UPLOAD`                     |
| `status`, `version`                     | `ACTIVE`/`VOIDED`; every change is the next version                                                             |

**Drafts ("k doplnění")**: only the original and the kind are needed to save. A document misses
for the export while any of supplier, number, issue date or handover month is missing; the list
filters them, the detail says what is missing. Missing values stay empty (never 0 or today).

Database rules (triggers): the original, source and identity never change; a change needs the next
version **and** its event (checked at commit); a voided document never changes; nothing is
deleted; events are append-only. One active document per file (SHA-256) and per supplier document.

## 4. API (company-wide, no site) — served by the Finance unit

| Method | Path                                                                                                    | Permission                 |
| ------ | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| GET    | `/api/admin/finance/suppliers`                                                                          | `finance:documents_manage` |
| GET    | `/api/admin/finance/supplier-documents?supplierId` (+ `procurement:documents_read` on their sites)      | `finance:documents_manage` |
| GET    | `/api/admin/finance/documents?q&supplierId&status&handoverMonth&incomplete&issuedFrom&issuedTo&page`    | `finance:documents_read`   |
| POST   | `/api/admin/finance/documents` (multipart: fields + `file`, PDF only)                                   | `finance:documents_manage` |
| POST   | `/api/admin/finance/documents/take-over` (`requestId`, `supplierDocumentId`, `kind?`, `handoverMonth?`) | `finance:documents_manage` |
| GET    | `/api/admin/finance/documents/:code`                                                                    | `finance:documents_read`   |
| GET    | `/api/admin/finance/documents/:code/content` (attachment, nosniff, CSP sandbox)                         | `finance:documents_read`   |
| POST   | `/api/admin/finance/documents/:code/correct` (`expectedVersion`, `reason`, all fields)                  | `finance:documents_manage` |
| POST   | `/api/admin/finance/documents/:code/void` (`expectedVersion`, `reason`)                                 | `finance:documents_manage` |
| GET    | `/api/admin/finance/health/live`, `/health/ready`                                                       | public (no data)           |

Idempotency (`finance.operation_requests`): an upload or takeover is identified by its `requestId`
over the **complete original request** (all metadata, file hash, author) — a replay returns the
same document even after later corrections; anything else under the id is 409
`IDEMPOTENCY_CONFLICT`; two concurrent identical requests create one document. Corrections and
voiding: `expectedVersion` (409 `STALE_VERSION`). Upload limit `FINANCE_DOCUMENT_MAX_BYTES`
(default as for supplier documents). The `%PDF-` signature is a format check, not a virus scan.

## 5. Permissions, roles and UI

`finance:documents_read`, `finance:documents_manage` — ADMIN only (core catalogue migration).
`FINANCE` stays a planned role. Taking over needs `procurement:documents_read` for the document's
site as well (the core decides, also on replay and download).

Finance → Přijaté doklady: receive a PDF (only the kind required), take over from Sklad, search and
filters (handover month, "jen k doplnění"), table/cards with the month and "K doplnění"; detail
with the original, source, what is missing, history, correction and voiding. If Finance is
unavailable, its pages say so; the rest of the app is unaffected.

## 6. Open questions for the owner (not assumed)

1. Should FINANCE (planned role) get these permissions when it becomes assignable, and who else?
2. The export month is now the explicit handover month (N2). Should the UI propose it (e.g. from
   the issue date) or always leave it to the person?
3. Other file types (ISDOC/XML, scans/photos)? Own uploads are PDF only (N1 brief); supplier
   documents taken over from Sklad keep their type.
4. May Finance create suppliers itself (landlord, accountant)? Now only via Sklad → Dodavatelé.
5. ADR 0039 §9: the core's own non-superuser DB role (two-sided isolation), a separate Finance
   web app, and the measured budgets.
