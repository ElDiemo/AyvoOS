# ADR 0039: Finance as a runtime unit — boundary, data, contracts and limits

- **Status:** Proposed — for the owner's decision. **Nothing in this ADR is implemented.** The
  Finance code of PR #67 / #68 runs inside the current API process; this ADR says what has to
  change before it may be merged, and asks the owner to choose (§8).
- **Date:** 2026-10-25
- **Builds on:** [ADR 0038](0038-runtime-units-and-fault-isolation.md) (Proposed, PR #65):
  "new: finance … built as separate units from the start". Review finding F-R1
  (REVIEW-N1-N2-20261025): a module directory and its own tables are not an independently
  deployable unit.
- **Scope:** Finance N1 (received documents) and N2 (export for the accountant), doc 039.

## 1. Where the code is today (b45372c / 0108eaa) — honestly

| Aspect          | Today                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process         | `FinanceModule` imported into `AppModule`: same process, heap, event loop and Prisma pool as warehouse, production, sign-in.                                                                     |
| Data            | Tables `finance_documents`, `finance_document_events`, `accounting_exports`, `accounting_export_items` in the shared `public` schema, written by the shared DB role.                             |
| Cross-unit FKs  | `supplier_id → suppliers`, `supplier_document_id → supplier_documents` (takeover), `created_by`/`actor_id → users`.                                                                              |
| Calls           | In-process `ProcurementService` (active supplier check inside Finance's transaction, supplier names/identities, supplier-document metadata and bytes) and the identity guard of the API.         |
| Shared code     | CSV writer (pure function), `FileStorage` (namespaces `finance-documents`, `accounting-exports`), `OperationRequestsService`.                                                                    |
| Failure domain  | A crash, leak or event-loop block in Finance (e.g. a large export) affects every module, and vice versa.                                                                                         |

So F-R1 is correct: the owner's isolation requirement is **not met** by this code.

## 2. Proposed unit

**`finance`** — its own container from the same image with its own entry point
(`node dist/finance/main.js`), its own health check, memory limit, DB pool and deploy/rollback.
It serves `/api/admin/finance/*` (Caddy routes that prefix to it; the web app is unchanged —
same origin). It runs no background loops.

| Resource                | Proposed budget                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Memory                  | container limit 768 MiB; export peak budget ≤ 2 × originals (100 MiB) + archive overhead ≈ 210 MiB (§5)           |
| CPU                     | 1 CPU                                                                                                             |
| DB connections          | pool 5, role `CONNECTION LIMIT 6` — within the ADR 0038 §4 budget                                                 |
| Concurrent export build | 1 per process; a second request is refused with `EXPORT_BUSY` (no queue)                                         |
| Upload                  | the existing `SUPPLIER_DOCUMENT_MAX_BYTES`, one file per request                                                  |

## 3. Data ownership

- Schema **`finance`**, role **`ayvo_finance`**: the only role that may write it; other roles get
  no grants on it; `ayvo_finance` gets no write grants outside it.
- **No foreign keys across units.** References to suppliers, supplier documents and users become
  plain ids plus the snapshot Finance needs (supplier name/ICO/DIČ as of the event; the user's
  display name as of the event). Finance-internal FKs and triggers (append-only events, the
  version guard, the export → document-version FK) stay.
- Files: the same private bucket, Finance's own prefixes; Finance never reads another prefix.
  A taken-over supplier document is **not copied** — its bytes are fetched through the
  procurement contract (§4) and verified against the stored SHA-256.
- Consequence: what DB constraints guarantee today across units (supplier exists and is active,
  supplier document exists, takeover once) is enforced by the contract plus a Finance-side
  unique index (`supplier_document_id` once while active), not by a cross-unit FK.

## 4. Contracts (versioned, `packages/types`, ADR 0038 §4)

| Call (Finance → owner)                                | Purpose                                                                                     | On failure                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `GET  /internal/v1/session/introspect` (identity)     | principal, current permissions and site scopes on **every** request                         | fail closed: 401/503                           |
| `GET  /internal/v1/suppliers?active=true` (core)      | suppliers to choose from                                                                    | form shows "Dodavatelé dočasně nedostupní"     |
| `GET  /internal/v1/suppliers/:id` (core)              | active check + identity snapshot at receive/correct/export                                  | the write is refused (503), nothing half-done  |
| `GET  /internal/v1/supplier-documents?…` (core)       | documents the principal may read (core checks `procurement:documents_read` on their sites)  | takeover unavailable                           |
| `GET  /internal/v1/supplier-documents/:id` (+content) | metadata/bytes for takeover, download and export, **checked for the calling principal**     | download/export refused; never a partial ZIP   |

Timeouts 2–5 s (content 30 s), at most 2 retries for idempotent reads only. Commands carry the
existing idempotency key (`operation_requests` in Finance's own schema). No outbox is needed
for N1/N2: Finance only reads from the core.

## 5. Limits and failure behaviour

- Export: admission check on declared sizes **before** any file is loaded; running sum of the
  actual bytes while loading; the archive is built **outside** any DB transaction; the final
  transaction (lock, re-check against the confirmed preview, insert) is short. Peak memory
  ≈ originals + archive (one copy each). Refusal, never a partial package.
- Finance down → nothing else is affected; core down → Finance alive but not usable (identity in
  the core until ADR 0038 P5); PostgreSQL/host down → everything down (shared, named).

## 6. Same topology on DEV and PROD

One more Compose service (`finance`) in `deploy/dev` and `deploy/prod`, the same image, the
standard deploy scripts, a Caddy route for `/api/admin/finance/*`. No new vendor, no broker,
no scheduler. Tests that stop the `finance` container and prove the rest still serves (and the
reverse) — ADR 0038 §6.

## 7. Reuse of the code already written

The service code is already written against a narrow surface: the procurement calls listed in
§1 and `FileStorage`. Moving it means: a `finance/main.ts` bootstrapping only `FinanceModule`
+ the introspection guard; replacing `ProcurementService` with an HTTP client of §4;
moving the CSV writer to `packages/`; migrations creating the tables in `finance` without the
cross-unit FKs. **Before anything is deployed this is cheap** (no data to move); after a merge
and deploy it needs a data migration.

## 8. Decisions for the owner

1. **A (recommended):** build the `finance` unit first — which needs ADR 0038 P1–P2 (separate
   processes, DB roles, connection budget) and the identity introspection contract — then
   merge Finance as that unit. N1/N2 stay open PRs until then.
2. **B:** accept Finance N1/N2 **temporarily inside the core process** as an explicit, dated
   exception (like the operations core in ADR 0038 §8.1), but already with the `finance` schema
   and no cross-unit FKs so the move needs no data migration. Not recommended without a date.
3. Memory/CPU/connection budgets of §2 (proposed values, to be measured on DEV).
4. Whether Finance keeps the takeover of supplier documents through the core contract (§4)
   or only uploads its own originals until that contract exists.
