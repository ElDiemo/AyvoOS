# ADR 0020: Operational modules and the application shell

- **Status:** Accepted — directed by owner 2026-10-11 (implemented for the DEV preview)
- **Date:** 2026-10-11
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** — (amends the UI placement of doc 018 §10)

## Context

The internal UI grew milestone by milestone: Bottles, Label templates and Sklad became peer
top-level items, and physical label application was placed in the warehouse. Navigation followed
database entities and implementation order. More functions (filling, crates, hotels, sales,
finance, ESG) will come and need a structure that scales and that roles can filter.

## Decision

- The internal application is organized by **company functions** ("operational modules"), not by
  entities. Implemented today: **Sklad** (physical inventory) and **Výroba** (production work:
  bottle identities and series, label printing, label templates, physical label application).
- Label application is a **Production** capability; it consumes warehouse stock only through the
  inventory ledger (ADR 0019).
- The shell: persistent left navigation (drawer on small screens) with the overview and the
  modules; each module brings its own contextual page navigation; a compact top bar with location
  and environment. One navigation model in the web app drives links, active states and breadcrumbs.
- Modules appear only when implemented. After authentication and RBAC (ADR 0017), the module list
  is filtered server-side by permission; the API enforces the same permissions.
- The hotel portal is a **separate customer environment**, not a module of this shell.
- Existing URLs of bottles, series and templates stay; moved pages get real HTTP redirects.
- This is a frontend architecture decision: backend Nest modules (`warehouse`, `assets`,
  `label-production`, …) and API paths are unchanged.

## Consequences

### Positive

- Navigation matches how AYVO works; new modules slot in without reshuffling.
- Role-based navigation needs only a server-side filter, no redesign.
- Operators find label application next to the series and print jobs it depends on.

### Negative

- URLs and module placement differ for bottles/templates (`/bottles` is shown under Výroba).
- The backend module that serves label application is still called `warehouse`; renaming it is
  deferred to avoid churn without behaviour change.

## Alternatives considered

- **Entity navigation with more top-level items** — rejected: does not scale, mixes functions.
- **Label application stays in Sklad** — rejected by the owner: it is production work.
- **Disabled placeholders for future modules** — rejected: dead navigation suggests features that
  do not exist.

## Open questions

- Language of the public passport (customer-facing).
- Production orders/sessions and product binding of label work (doc 019 §7).
