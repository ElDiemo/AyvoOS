# 024 — Night shift: approved feature → review → CI → merge → DEV deploy → morning report

Status: **Designed and implemented in the repository, not installed** (issue #13). The live runner
on the server is unchanged; installing this version is a separate, owner-approved step
(`ops/night-shift/INSTALL.md`). Automatic merge and DEV deploy become possible only for a
concrete run the owner signs (§5), after the pilot (§10).

## 1. Inventory of the live runner (2026-10-13, read-only)

| Item                   | Finding                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation           | `/opt/ayvo/night-shift` (mode 700): `bin/night_shift.py` (controller), `run-night.sh`, `schedule.sh`, `Dockerfile`, `OPERATIONS.md`, `MANIFEST.sha256`; wrapper `/opt/ayvo/bin/ayvo-night-shift`. Not in Git until now. |
| Schedule               | One managed crontab block: `*/10 * * * * schedule.sh`; starts once per day at 22:30 Europe/Prague (`last-scheduled-date`). No systemd timer, no second orchestrator.                                                    |
| Model isolation        | Docker image `ayvo-night-shift-runner:2.1.296-node24`; read-only root, `--cap-drop=ALL`, no secrets, no Docker socket; mounts the worktree, the repo's `.git` read-only, a cache and `~/.claude` (model login).         |
| Flow                   | `prepare` (exact base = `origin/main`, worktree, `night/*` branch) → `work` (Sonnet implements; local gates; Fable/Sonnet review, max 2 rounds) → `publish` (push, PR, wait for CI). **Never merges or deploys.**       |
| Queue                  | `queue/ready` empty; `queue/running/20261012-product-catalog-bom.json` **blocked**; `queue/cancelled/20261012-identity-access-editor-ux.json`.                                                                          |
| **Bug: never ran**     | The catalogue job failed at its first container start: `docker: range of CPUs is from 0.01 to 2.00` — the runner asks for `--cpus=4` on a 2-CPU host (exit 125). `--memory=10g` on a ~4 GB host shares memory with DEV. |
| Stale job              | The blocked job duplicates PR #12 (done by hand). Tonight's run finds `queue/ready` empty and goes idle; the job file stays in `running`. Recommended: the owner cancels it (move to `queue/cancelled`).                |
| Integrity file         | `MANIFEST.sha256` lists job files at old queue positions (stale after queue moves); it is not a runtime check.                                                                                                          |
| GitHub access          | `ayvo-gh` (GitHub App): PR create/edit/comment, read; merge only with `AYVO_GH_ALLOW_MERGE=<n>`; **no Issues permission** (cannot write issue comments).                                                                |
| **Identity on GitHub** | Codex comments appear as the owner's account (`ElDiemo`, association `owner`). A GitHub comment, label or account is therefore **not** proof of the owner's approval.                                                   |
| Shared checkout        | The controller uses `/opt/ayvo/repos/AyvoOS` (the interactive checkout); `prepare` refuses when it is not clean on `main`.                                                                                              |

## 2. Target: one system, extended

The repository now holds the runner (`ops/night-shift/`, first commit = verbatim import) and its
extension. The PR-only queue keeps working unchanged (`night_shift.legacy`, with the CPU/memory fix).
New: **approved runs** (`night_shift.cli`, `ayvo-night-shift delivery …`) processed first by the same
nightly `run-night.sh`, under the same crontab entry and the same full-run lock. No new cron entry,
no second orchestrator.

```
Codex: feature brief (issue)  →  owner: signs the run manifest  →  22:30 shift:
  verify signature → implement (Sonnet, container) → scope check → independent review (Fable for
  critical parts, fresh session, must not edit) → repair ≤ N → push + PR → CI on the exact head →
  merge gate → merge (wrapper, per-PR authorization) → CI on the merge commit → next part … →
  deploy gate → scripts/deploy-dev.sh of the exact merge commit → checks → morning report on the PR
```

## 3. Roles and trust boundaries

| Actor                      | Can                                                            | Cannot                                                                                      |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Owner                      | sign or revoke a run manifest (own SSH key, own computer)      | —                                                                                           |
| Codex                      | write the feature brief and a draft manifest; review on GitHub | approve a run (no owner key)                                                                |
| Model worker (container)   | edit the worktree, run allow-listed local commands             | commit, push, use GitHub, Docker, secrets, the network to DEV/production, the runner itself |
| Controller (deterministic) | git, push, PR, merge (gated), DEV deploy (gated), report       | change its own policy; deploy anything but the verified merge commit to DEV                 |

## 4. Run manifest (`ayvo-night-shift-run/1`)

Strict JSON (unknown keys are errors), validated by `night_shift/manifest.py`; example in
`ops/night-shift/examples/run-manifest.example.json`.

| Field                                     | Rule                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`, `feature.issue`, `brief_sha256` | identify the run and the exact approved brief snapshot                                                                                              |
| `base_commit`                             | full SHA; `main` must be exactly there when the run starts                                                                                          |
| `parts[]` (1–3)                           | chained PRs: `slug`, `title`, `task_sha256` (task file next to the manifest must match), `risk` (`critical` ⇒ Fable review)                         |
| `scope.allowed_paths` / `forbidden_paths` | globs; never `**`; always forbidden: `.github/**`, `deploy/**`, `scripts/deploy-*.sh`, `ops/**`, `.env*` (except `.env.example`), keys, `CLAUDE.md` |
| `migrations`                              | `allowed`, `max_new` (0–5), `destructive: false` (always); migrations outside the approval block the run                                            |
| `permissions`                             | `allow_merge`, `allow_deploy_dev` (deploy needs merge)                                                                                              |
| `ci.required_checks`                      | must include `quality`, `test`, `e2e`                                                                                                               |
| `acceptance[]`                            | scenarios reported one by one                                                                                                                       |
| `budget`                                  | 30–600 minutes, 0–3 repair rounds, 1–3 attempts per step                                                                                            |
| `target`                                  | exactly `{"environment": "dev-preview", "url": "https://dev.ayvo.co"}` — production and WorkOS are not targets                                      |
| `valid_from` / `valid_until`              | at most 24 hours                                                                                                                                    |

**Glob dialect:** `*` and `?` match within one path segment, `**` spans segments, a leading
`**/` also matches the top level. Paths are matched exactly as git reports them (only a literal
leading `./` is removed); absolute paths and `.`/`..`/empty segments are refused.

Any change to the manifest changes its SHA-256 and voids the signature. The run directory keeps the
copies the run started with; comments or edits on GitHub never reach it.

## 5. Owner approval

- **Signature:** the owner signs the manifest's canonical bytes on their own computer:
  `ssh-keygen -Y sign -f ~/.ssh/<key> -n ayvo-night-shift-run manifest.canonical`
  (`ayvo-night-shift delivery hash manifest.json` writes the canonical file and prints the hash).
  The signature is not secret and may travel by any channel.
- **Trust anchor:** `/etc/ayvo/night-shift/allowed_signers`, **owned by root**, not writable by
  group/others — the controller refuses otherwise. The model, Codex and the `ayvo` user cannot
  add a key. Installed once by the owner with sudo.
- **Re-verified** before the run starts, before every merge and before the deploy (window,
  revocation, signature).
- **Revocation:** `touch /opt/ayvo/night-shift/revoked/<manifest-sha256>` stops the run at its next
  gate (anyone who can write there can only stop, never grant).

## 6. State machine and resilience

`queued → implementing → reviewing → ci → merging → merged → (implementing of the next part) →
deploying → verifying → verified | deployed_unverified`; stops: `awaiting_owner` (no merge/deploy
allowed), `blocked` (a rule), `failed` (an unexpected error), `cancelled`.

- Each transition and fact (base, head, review, PR, merge commit, CI, deploy) is checkpointed:
  atomic `state.json` + fsynced append-only `events.jsonl` (mode 600, dir 700).
- Side effects record their **intent first** and are reconciled on resume: an existing PR of the
  branch is reused; a merged PR is adopted only if this run recorded the merge intent; a started
  deploy is reconciled with `deployments-dev-preview.log` — an unknown outcome blocks instead of
  deploying twice.
- One controller lock (`controller.lock`) plus the existing full-run and deploy locks.
- The controller never runs git through a worktree's own `.git` (the model could replace it): it
  passes the trusted per-worktree git dir from the main repository and disables fsmonitor, hooks,
  pager and external diff; a replaced `.git` stops the job (independent review, P0 — this also
  closes the same gap in the live PR-only runner).
- The time budget counts from the start of the run; a resume after a long outage may find it
  exhausted and block — the owner re-plans instead of letting stale work continue.
- Transient adapter errors retry up to `max_attempts_per_step`; the time budget stops new work
  (an ongoing deploy finishes); CI that never finishes hits the budget.

## 7. Merge gate (all must hold, bound to exact commits)

Manifest allows merge; approval valid; PR created by this run, from its branch into `main`, open;
`main` exactly at the part's base (else **stop and re-plan, never overwrite**); independent review
of exactly the PR head with no P0–P2 findings; `quality`, `test`, `e2e` successful on exactly that
head; ruleset "Protect main" active; changed paths in scope; migrations within the approval. Then
`ayvo-gh pr merge <n> --merge` with `AYVO_GH_ALLOW_MERGE=<n>` (normal merge commit; never
`--admin`, `--auto`, branch deletion). Afterwards the merge commit must have exactly the parents
(expected main, reviewed head), `main` must be at it, and CI must pass on it. A later part starts
from that merge commit.

## 8. DEV deploy gate and verification

- **Gate:** manifest allows the DEV deploy; approval valid; every part merged (DEV gets only the
  complete result); `main` still at the last merge commit; CI green on it; **no change to the
  deployment tooling** (`deploy/**`, `scripts/deploy-dev.sh`) since the deployed commit;
  migrations only as approved; verification credentials present; deploy lock free; DEV healthy.
- **Deploy:** a clean detached worktree at exactly the merge commit runs its
  `scripts/deploy-dev.sh` (backup → `prisma migrate deploy` → start → built-in verification). The
  Basic Auth password comes from an owner-provisioned, controller-only file
  (`/opt/ayvo/secrets/night-shift/dev-verify.pass`, mode 600) — never argv, never logs, never the
  model container.
- **Trust in merged code:** build steps that are in scope (e.g. `apps/*/Dockerfile`) run during
  the deploy once merged — they passed review, CI and the scope gate, but they are executed. Only
  the deployment tooling itself (`deploy/**`, `scripts/deploy-dev.sh`) is never taken from a run.
- **Rollback:** an image rollback (`--rollback <previous tag>`) only when no migration was pending
  (after a failed deploy, pending migrations count as possibly applied); never a database restore
  over newer data; on data risk stop and report.
- **Verification:** the deploy script's checks (services, TLS, Basic Auth 401, noindex,
  HTTP→HTTPS, sign-in page, `/api/auth/me` 401, API health) plus container health. A signed-in
  application check and the acceptance scenarios need a smoke identity (§11); without them the run
  ends `deployed_unverified` and the report says so — never "verified".

## 9. Morning report

Written to the run directory and as a comment on the run's last PR (the wrapper cannot comment on
issues): headline, reason, manifest hash and base, per part PR/base/head/review/CI/merge commit/CI
on merge, DEV deploy (commit, image tag, previous tag, migrations, backup path, rollback), checks,
each acceptance scenario, the URL to try. No credentials, no personal data.

## 10. Activation plan

1. **This PR** — inventory, design, implementation with tests (no installation, no live change).
2. **Installation** (owner, `INSTALL.md`): root-owned trust anchor with the owner's public key;
   controller-only verification password file; copy `ops/night-shift` to `/opt/ayvo/night-shift`
   (the queue and state stay); cancel the stale catalogue job; `ayvo-night-shift check`.
3. **Dry run** — a signed manifest with `allow_merge: false` (PR-only) to prove signature,
   container and CI end to end.
4. **Pilot** — one small feature the owner signs with `allow_merge` and `allow_deploy_dev`;
   morning check of the report and DEV.
5. Larger features only after a successful pilot.

## 11. Owner decisions needed before installation

1. **Merge policy:** doc 017 says merging is never automatic; this design makes a signed run
   manifest the per-PR authorization. Confirm (doc 017 is updated in this PR accordingly).
2. **Signing key:** which SSH public key is the owner's approval key (`allowed_signers`)?
3. **Signed-in smoke check:** a dedicated WorkOS Staging smoke user for DEV (no MFA, or a TOTP
   secret held only by the controller), and the minimum role it gets — or accept that automated
   runs end `deployed_unverified` and the owner checks signed-in screens in the morning.
4. **Verification password:** may the controller keep the DEV Basic Auth password in a persistent
   controller-only file (today it is created per deploy and deleted afterwards)?
5. **Reports in issues:** grant the GitHub App `Issues: write` so the report also lands in the
   feature issue, or keep reports on the PR only.
6. **Capacity:** the host has 2 CPUs and ~4 GB RAM shared with the DEV preview; a night build plus
   tests plus a deploy is tight. Accept the reduced limits, or move the runner to more capacity.
7. **Network of the model container:** it has unrestricted outbound access today (it needs the
   model API); no DEV, GitHub or production secret is mounted, but repository content could leave
   the host. Confine egress (allow-list proxy) before larger runs, or accept the risk.
8. **Stale job:** cancel `20261012-product-catalog-bom` (superseded by PR #12)?
