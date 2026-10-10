# ADR 0015: Immutable label template versions and reproducible print jobs

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Date:** 2026-10-10
- **Deciders:** AYVO owner; AYVO OS lead architect

## Context

Bottles are labelled once and keep their label for years. If 500 bottles were printed with
`mydlo1` and the artwork or QR position later changes, AYVO must still know — and be able to
reproduce — exactly what those 500 labels look like. Physical layout must be expressed in
printer units, not browser pixels.

## Decision

- A **LabelTemplate** (`mydlo1`) is a name with **immutable versions**. A version snapshots the
  physical size (mm), the artwork (immutable stored file) and every element's box in mm.
- **Every saved change creates a new version** (no drafts, no edits). Saving an identical layout
  creates nothing. Version numbers are allocated under a row lock on the template.
- Immutability is enforced in PostgreSQL: triggers reject UPDATE/DELETE on versions, elements
  and artwork rows; artwork files are never overwritten (storage refuses existing keys).
- A **BottleCreationBatch** records the version selected at registration; a **LabelPrintJob**
  records its version, its exact bottles (job items in page order) and its QR base URL. These
  identity columns are immutable; only the job's processing state changes.
- **New batches use only the latest version of an active template** (enforced by the API, not
  only the UI). Historical batches and print jobs always use their exact recorded version.
- **Archiving:** a template can be archived (hidden) and restored. Archived templates keep every
  version for historical reproduction but cannot be selected for new batches or edited. Templates
  are **never deleted**; a database trigger rejects DELETE.
- **Renaming is currently disabled** (DB trigger on the name). This was an implementation choice,
  not an owner rule. It can be enabled once (a) template versions snapshot the name they were
  created under, so history is never relabelled, and (b) administrative changes are audited with
  an actor (ADR 0006 audit log, ADR 0017 identity) — see doc 016.
- Layout model: millimetres with 0.01 mm precision, top-left origin, y downwards; QR box includes
  the quiet zone and is square. The designer converts pixels to mm immediately.

## Consequences

### Positive

- Any historical print job can be regenerated with the identical layout.
- Simple mental model for operators: "mydlo1 v2" means exactly one design.
- No "edit in place" bugs that silently change past output.

### Negative

- Versions accumulate (small rows; artwork files are the main storage cost).
- A typo fix also creates a new version; there is no way to correct a version in place.

## Alternatives considered

- **Mutable template + audit log** — rejected: reproducing old output would require replaying
  the log; easy to get wrong.
- **Draft/published workflow** — more states and UI for little benefit in v0.1; can be added
  later on top of immutable published versions.

## Open questions

- None for v0.1. PDF artwork backgrounds (with a browser preview) are deferred to a later
  milestone.
