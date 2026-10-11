# ADR 0019: Inventory ledger with protected balances, and idempotent operations

- **Status:** Accepted — confirmed by owner 2026-10-11 (doc 018)
- **Date:** 2026-10-11
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** —

## Context

AYVO must track many materials (new bottles, pumps, liquids, label media, packaging) in exact
quantities, with lots, supplier documents and full auditability, while warehouse scans are
retried, double-submitted and executed concurrently. Stock must never become negative or drift,
and no operation may be applied twice ([018](../018-inbound-stock-and-label-activation.md)).

## Decision

- **Ledger as source of truth:** `inventory_movements` is append-only; every row has exactly one
  typed source (receipt line, receipt correction, bottle event + BOM line, …) and must match it.
- **Protected balance:** `inventory_balances` per (item, location, lot) is written only by the
  ledger's insert trigger, in the same statement; `CHECK (on_hand >= 0)` aborts any overdraw.
  A drift function (`ayvo_inventory_drift()`) proves balance = Σ ledger.
- **Exact quantities:** `NUMERIC(19,3)`, decimal strings in the API, one base unit per item,
  per-unit decimal places enforced in the database.
- **Idempotent operations:** every mutating request carries a client request id; one generic
  `operation_requests` table (payload hash + stored result) makes the whole operation run exactly
  once in a single transaction; reuse with another payload is a conflict; rejections are not
  stored.
- **Commit-time consistency:** deferred constraint triggers check multi-row facts (a label
  application has its event, status, attachment and stock consumption; a receipt has lines,
  movements and a required document).
- **Fixed lock order:** operation request → asset rows → receipt lines → balances (item,
  location, lot), so concurrent operations cannot deadlock.

## Consequences

### Positive

- Stock cannot go negative or drift even through bugs in application code.
- Retries, refreshes and concurrent scans are safe by construction and testable.
- New materials and movement types are additive (new enum value + source column + rule).

### Negative

- More database logic (triggers) to review and test; migrations must keep the rules intact.
- Balance rows serialize concurrent consumption of the same (item, lot) — intended, but a hot
  spot at very high scan rates.

## Alternatives considered

- **Mutable stock counter updated by the application** — drifts silently, no audit trail.
- **Balances computed on the fly only** — correct but slow for stock views and needs locking
  anyway to prevent overdraw.
- **Per-table idempotency columns only** — duplicates logic per operation and cannot detect a
  reused request id with a different payload uniformly.
