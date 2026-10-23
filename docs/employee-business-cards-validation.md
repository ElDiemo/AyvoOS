# Local validation — employee cards, 2026-10-23

Implementation on `codex/employee-business-cards`, based on main `6a02953295ef38f225b865cbca5addf999cf1a49`.
Local worktree is separate from Claude's checkouts. Nothing was pushed, merged or
deployed; no live profiles, contacts, sessions or portraits were imported.

## Verified

- API TypeScript and ESLint, web TypeScript and ESLint, shared-types TypeScript/ESLint.
- Prisma client generation and schema formatting. The entire migration history
  including this new migration applied to fresh, synthetic PostgreSQL 18 databases.
- API build (`nest build`).
- Web build with **webpack**, on the final implementation. The default Turbopack
  build was attempted but its CSS worker failed with OS EPERM when binding a port,
  including after sandbox escalation. This was not a TypeScript failure; default
  Turbopack and the normal Linux image build remain for CI.
- Shared types: 34 tests passed (18 employee-card boundary cases).
- Web: 104 tests passed, including escaping and inert preview buttons.
- Employee-card API: 19 tests passed (9 unit + 10 integration). The final replay
  change was rechecked with all 10 integration cases in another fresh database.
  Authentication uses real AYVO guards/sessions plus the approved test-only
  identity provider, not a DEV/PROD login bypass.
- Integration cases include anonymous/SALES refusal, private upload and draft,
  explicit publication and DTO whitelist, current-publication photo versions,
  unmodified public data after draft edits, concurrent saves, stable slug,
  idempotency conflicts, replaying an old publish after hide, photo revocation
  during storage I/O, cross-user photo rejection, SQL checks, inactive-user
  publication rejection, automatic hide and no automatic republication, fail-closed
  Redis failure.
- Browser acceptance: the normal administrator/operator auth setup passed. Full
  card flow passed in installed Chrome using a new test profile: upload → draft →
  public page → vCard download → private edit → reload → hide with unsaved text kept.
  A second scenario covers concurrent first creation, preservation of entered
  fields, adoption of the permanent server slug, and visible server-value comparison.
  Final run: **both browser scenarios passed**, 2/2 in 35.4 seconds, including
  an explicit check that the private preview photograph finished loading.
- Screenshots in `docs/screenshots/employee-cards/`: editor and public card at
  1440, 390 and 320 px. Browser asserts no horizontal page overflow. All names,
  phone numbers, emails and portraits are synthetic (the photograph is initials).
- Repository formatting and `git diff --check`.

## Not passed / not claimed

The complete API suite was attempted over an SSH-forwarded, resource-limited
temporary PostgreSQL instance. Unrelated `catalog.e2e.test.ts` tests hit a 60 s
timeout (one case reported 60024 ms; another subsequent case failed). The full run
was stopped, rather than presented as green. The precise cause was not proved by
a baseline run. **Full API/CI success is still a merge gate.** Do not weaken tests,
increase production permissions or alter unrelated catalogue behavior to conceal it.

The local API/Redis/database instances were test-only: separate named containers,
loopback ports, ephemeral DB storage, resource limits 384 MiB/0.5 CPU for PostgreSQL
and 64 MiB/0.25 CPU for Redis. Test execution ran on the notebook. Live application
containers, their data and Claude's worktrees were not altered. Temporary instances
and local listeners are removed/stopped after acceptance.

No live domain takeover, Apache/DNS change, real-profile import, production S3
acceptance, external visitor-IP/proxy test, normal Docker build or CI has been
performed for this branch. See the cutover checklist and ADR 0036; these are not
covered by a screenshot or a successful `/health` response.

## First GitHub CI and follow-up

PR #55 was pushed at `d2f18af`. Run `39989753581` passed quality (including the
normal Linux/Turbopack build) and the full browser suite. API tests reported
659 passed, 2 skipped and 3 failures: the public-route allowlist needed the
three deliberately public card routes, and both schema-drift checks detected
the implicit Prisma `ON UPDATE CASCADE` differing from the new SQL foreign
keys' `NO ACTION`. This was not a green API run and was not dismissed as CI noise.

The follow-up explicitly keeps `onUpdate: NoAction` in both Prisma relations,
matching the already-written SQL without changing a migration. The access
allowlist names only those three routes; it is not widened to all public paths.
The editor gains a same-environment link to the published card, removed when
hidden. A card-specific unavailable page has no links into the private OS.
The browser regression checks the link and the hidden page. New CI is required
on the follow-up head before merge/deploy. Initial screenshots predate this
small editor-link addition; they remain examples, not proof of a live DEV page.
