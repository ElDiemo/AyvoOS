# ADR 0048: The hotel portal's operational boundary — Finance terms revisions and a guard for older images

- **Status:** Accepted — the owner decided all three questions (§ Decisions, 2026-11-11, #180
  comment 6800978787). A PROD migration or deployment still needs its own approval.
- **Date:** 2026-11-11
- **Deciders:** the owner (AYVO); proposed by Claude Code, independently reviewed in #169
- **Supersedes / Superseded by:** — (complements ADR 0045 §6–§8, the portal's data boundary)

## Context

A payer's portal account sees a hotel's invoices, and — only while that payer is the hotel's
current payer — its operations: detail, profile, contracts, deliveries (review 5841786998 P1; v6
in #148 comments 6773883145 / 6773928715). The core holds the grants (`portal_grant_hotels.access`
INVOICES | OPERATIONS, `checked_revision`, `operations_until`, #177 = A1); Finance alone knows the
payer and the terms. A change of payer must close the old payer's operations **before** the
change exists, survive a lost answer, an outage and an abandoned change, and never be lifted by
anything but an explicit restore. A return to an image older than the boundary must not reopen
what the boundary closed.

## Decision

1. **Terms revisions in Finance** (#180, migration `20261115100000_billing_terms_revisions`):
   every change of an agreement's terms is a numbered revision (`billing_terms_revisions`,
   append-only, with append-only events FENCED / COMMITTED / ABANDONED / RESOLVED_SENT, rules in a
   trigger). A change that takes the hotel from its payer is a TRANSFER: reserved under the terms'
   lock, then the core's fence for the leaving payer (no Finance transaction held during the
   call; a request id derived from the transfer's, so every attempt names the same fence), then
   committed only if the agreement is unchanged since the reservation — else ABANDONED. While a
   transfer is reserved, no other change, restore or grant check of that agreement is accepted
   (`TERMS_CHANGE_PENDING`). "Zrušit" first settles the fence request at the core
   (`portal-fences/settle`), so a fence Finance never got an answer for is still recorded and a
   late request writes nothing.
2. **Restore only from a committed RESTORE**: the core accepts a resolution only as typed
   evidence built from a stored RESTORE revision in state COMMITTED that names fences of this
   agreement's transfers of that payer, each fence resolved at most once. A price or any other
   CHANGE never lifts a fence, whatever its revision.
3. **A grant check** sends the agreement's highest terms revision (reserved or recorded) and the
   end of operations; the core closes operations for every fence of the payer × hotel after its
   `ends_on` unless it was resolved and the grant checked in the restore revision or later.
4. **A guard for older images** (Core migration `20261115090100_portal_boundary_old_image_guard`):
   row-level security on `portal_grant_hotels` for the runtime role. A connection of this image
   says `ayvo.portal_boundary = 'v6'` and sees every row (it applies the rule itself). Any other
   connection sees a grant's hotel only when it is OPERATIONS and no fence closes it, and cannot
   insert one. The marker is a version marker, not a credential (the role, its password and the
   network stay the boundary). An older Finance image cannot write terms (`terms_revision` NOT
   NULL), so never a change of payer without its fence.

## Decisions

| #   | Question                                                                         | Today's code              | Independent review's recommendation                | Decided                                   |
| --- | -------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------- | ----------------------------------------- |
| 1   | The RLS guard of §4 as the DB safeguard for a return to an older Core image      | in #180                   | yes, with this ADR and its tests                   | yes — owner 2026-11-11, review 6800978787 |
| 2   | An earlier end of the terms (`validTo`) counts as the payer leaving (a TRANSFER) | yes (`leavingPayer`)      | yes — fail-closed for operations after the new end | yes — owner 2026-11-11, review 6800978787 |
| 3   | RESTORE only for the payer whose terms are in effect today                       | yes (`RESTORE_NOT_PAYER`) | yes — never rights back for a historical payer     | yes — owner 2026-11-11, review 6800978787 |

The owner approved these three rules, not any later diff: the existing regressions and migrations
stay as they are, and a change to them goes back to the owner.

## Evidence (synthetic data, per-run test databases)

- `finance-portal-boundary.e2e.test.ts` (7): immediate and next-month change of payer, lost
  answer, core down + "Dokončit" / "Zrušit" with a late request, v6 test 5 (a price revision never
  restores), a restore sent again, an older Finance cannot write terms.
- `portal-boundary-review.e2e.test.ts` (3, in #148): an older image and an invoices-only hotel
  without a fence (failed before `bafb633`); an earlier `validTo` is a fenced TRANSFER that a later
  CHANGE never lifts; contracts and deliveries 404 for the fenced old payer, 200 for the new one.
- **Return rehearsal** (main `c58f8a1` against a database migrated by #180, the method of
  `rollback-compat.e2e.test.ts`): the policies exist; the older core reads a grant with an open
  OPERATIONS, an INVOICES and a fenced hotel as **only the open one**; it cannot write a grant
  (refused by the database, nothing written); Finance's `terms_revision` is NOT NULL. 4/4 —
  with the RLS of before `bafb633` the INVOICES hotel was visible (failed).
- CI #148 `20f1fde` (A1 + A2 + contracts): 43029348771 green.

## Consequences

### Positive

- A change of payer on the normal Finance route closes the old payer's operations before it
  exists; outages and lost answers fail closed; only an explicit, recorded restore reopens.
- A return to an older image never reopens a fenced or an invoices-only hotel.

### Negative

- After a return to an older image, invoices-only and fenced hotels are not part of the grant at
  all: their invoices wait for the newer image (fail-closed).
- A reserved, unsettled transfer blocks the agreement's other changes and grant checks until
  "Dokončit" or "Zrušit".
- Row-level security is new in this codebase: every new read of `portal_grant_hotels` by a
  connection without the marker (a tool, a script) sees the restricted view.

## Alternatives considered

- **No DB guard, rely on not rolling back** — a rollback is the documented incident path (doc
  036 §7); rejected by the review.
- **Fences only in the core, Finance unaware** — a lost answer would leave Finance without the
  fence id, so a restore could not name it; rejected in v3–v6.
