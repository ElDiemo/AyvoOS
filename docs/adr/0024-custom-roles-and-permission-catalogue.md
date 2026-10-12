# ADR 0024: Custom roles over a migration-governed permission catalogue

- **Status:** Accepted — directed by the owner 2026-10-12; implemented in Milestone 2C
  ([doc 021 §7a](../021-identity-and-access.md))
- **Date:** 2026-10-12
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Related:** [ADR 0022](0022-external-oidc-authentication.md)

## Context

The eight system roles of ADR 0022/doc 021 cover AYVO's main functions, but real teams need
combinations (e.g. "receives goods only") without waiting for a code change. At the same time the
meaning of each permission, the ADMIN role and security administration must stay reviewed.

## Decision

1. **Permissions are code**: the catalogue changes only through a reviewed migration (database
   guard). Each new permission is granted to ADMIN explicitly in the same migration — ADMIN sees
   and manages the whole system through ordinary role-permission rows, never a code bypass.
2. **System roles are protected templates** (seeded, changed only by migration; never renamed,
   edited or deleted through the application). They may be duplicated.
3. **Custom roles** are created by ADMIN (`identity:roles_manage`): code, Czech name,
   description, permissions chosen by checkbox, active/inactive, timestamps, audit. A custom role
   holds exactly what was chosen — it never acquires a permission added later unless ADMIN adds
   it. It can be deactivated only when nobody holds it; an inactive role cannot be granted.
4. **Security administration** (`identity:*`, `sites:manage`, `sites:all_access`) belongs to the
   ADMIN system role only; a custom role cannot hold it (database-enforced). No actor can grant a
   permission it does not hold.
5. **No direct per-user permission overrides** in v0.1: a special combination is a named custom
   role, so it stays understandable, reusable and auditable.
6. Every role or assignment change needs a reason, writes an append-only audit event and applies
   to active sessions on their next request (authorization is read from the database per request).

## Consequences

- Access can be tailored without deployments, while the vocabulary (permissions) stays reviewed.
- A permission split or rename needs a migration that also updates affected custom roles
  deliberately.

## Alternatives considered

- **Per-user permission checkboxes** — rejected: opaque, unauditable combinations.
- **Editable system roles** — rejected: their meaning is referenced by code and documentation.
