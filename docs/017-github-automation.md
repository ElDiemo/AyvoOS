# 017 — GitHub automation (AYVO Automation GitHub App)

Status: **Accepted for the DEV server** — owner, 2026-10-11
([ADR 0018](adr/0018-github-app-automation.md)).

How the DEV server talks to GitHub for pull requests, without a human login, a personal access
token or manual copying. Git pushes are unaffected: they keep using the existing SSH remote.

## Architecture

```text
ayvo-gh <gh arguments>                         /opt/ayvo/bin/ayvo-gh (from scripts/ayvo-gh)
  │ 1. policy: allowed operation? merge authorized?        (no network, no files)
  │ 2. App JWT, RS256, ≤ 10 min, signed with the App key   (/opt/ayvo/secrets/github-app/)
  │ 3. POST /app/installations/{id}/access_tokens
  │       repositories: [AyvoOS], permissions: only what this operation needs
  │ 4. gh runs with GH_TOKEN in its environment only        (subshell; temp GH_CONFIG_DIR)
  └ 5. on exit: DELETE /installation/token (revoked), temp config removed
```

- **Identity:** the GitHub App **AYVO Automation**, installed on the `ElDiemo` account for **only
  the `ElDiemo/AyvoOS` repository**. Its actions appear on GitHub as the app's bot account, never
  as a person.
- **No long-lived credentials besides the App private key.** Every call mints a new installation
  token (GitHub limits it to 1 hour), restricted to the one repository and down-scoped to the
  permissions of that call; the wrapper revokes it as soon as `gh` exits. Tokens are never
  written to disk.
- **The wrapper** (`scripts/ayvo-gh`, installed as `/opt/ayvo/bin/ayvo-gh`) is the only supported
  entry point. Plain `gh` on this server has no credentials (`gh auth login` is never used).

## Threat model

| Threat                                              | Mitigation                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token or key leaks via process list, history, logs  | The `Authorization` header reaches curl on stdin (`--config -`), never argv. `GH_TOKEN` is set by a prefix assignment on `exec` (not `env NAME=…`). No `set -x`, no logging of secrets, errors show GitHub's message only.                                      |
| Token leaks via files                               | Tokens exist only in memory; `gh` gets a fresh temporary `GH_CONFIG_DIR` that is removed (after strict path validation) when the call ends.                                                                                                                     |
| Stolen token used later                             | Revoked at the end of every call; at most 1 hour lifetime even if revocation failed.                                                                                                                                                                            |
| Access beyond AyvoOS                                | App installed on the AyvoOS repository only; every token request names only AyvoOS; the wrapper refuses a token covering anything else.                                                                                                                         |
| Accidental or automatic merge                       | `pr merge` needs `AYVO_GH_ALLOW_MERGE=<that PR number>`, an explicit method, and refuses `--auto`, `--admin`, `--delete-branch`. Only merge calls receive `contents: write`. No auto-merge of green branches.                                                   |
| Arbitrary API mutations                             | `gh api` is GET-only (no `-X POST/PUT/PATCH/DELETE`, no `-f/-F/--input`, no `graphql`); every other `gh` command is refused unless listed below.                                                                                                                |
| Config file injection                               | `app.env` is parsed, never sourced: three known keys, validated values; anything else is refused.                                                                                                                                                               |
| Weak file permissions                               | Refuses to run unless the directory is 700, files 600, owned by the calling user, and not symlinks.                                                                                                                                                             |
| Compromise of the `ayvo` user or root on the server | **Residual risk:** whoever controls this account can read the App key and act with the App's permissions on AyvoOS (including pushing via `contents: write`). Mitigate with GitHub branch protection on `main` (owner setting) and by revoking the key (below). |

The wrapper is a guard rail against mistakes, not a sandbox: the App key itself is the security
boundary, so it stays on this server only, with mode 600.

## GitHub App permissions (repository only)

| Permission      | Access         | Used for                                                    |
| --------------- | -------------- | ----------------------------------------------------------- |
| Metadata        | Read (default) | Repository lookup (mandatory for every App)                 |
| Contents        | Read and write | Read branches/commits; **write only for authorized merges** |
| Pull requests   | Read and write | Create, edit, comment, mark ready                           |
| Checks          | Read           | `pr checks`                                                 |
| Commit statuses | Read           | `pr checks`, branch status                                  |
| Actions         | Read           | `run list`, `run view`                                      |

No organization or account permissions. Not granted: Administration, Secrets, Workflows,
Members, Environments, Deployments, Issues, or anything else. Webhooks are disabled (nothing
listens). A new permission needs a documented requirement, an update of this table and the owner's
approval on GitHub (GitHub asks the installation owner to accept added permissions).

Each call requests only part of this: read calls get read-only tokens; `pr create/edit/comment/
ready` add `pull_requests: write`; only an authorized `pr merge` gets `contents: write`.

- **Contents: Read and write is required for merging** — GitHub's merge endpoint needs it. Normal
  calls never receive it (their tokens ask for `contents: read`).
- **Issues is not needed:** comments on pull requests work with `Pull requests: write`; the
  wrapper refuses `gh issue …` anyway.

## Allowed and refused operations

Allowed (token permissions in brackets):

- **Read** — `repo view`; `pr list`, `pr view`, `pr status`, `pr checks`, `pr diff`; `run list`,
  `run view`; `api <path>` with GET only.
- **Pull requests** — `pr create`, `pr edit`, `pr comment`, `pr ready`.
- **Merge** — `pr merge <number> --merge|--squash|--rebase`, only with explicit authorization.
- **Audit** — `ayvo-gh --whoami`, `ayvo-gh --discover-installation` (see below).

Refused (exit 1, before any network access): every other command, e.g. `pr close/reopen/review/
checkout`, `repo delete/edit/clone`, `release`, `secret`, `workflow`, `issue`, `auth token`,
`auth login`; `gh api` with a non-GET method, request fields, `--input` or `graphql`; `pr merge`
with `--auto`, `--admin`, `--delete-branch`/`-d`, `--disable-auto`, without a PR number, without
a merge method or without authorization.

## Explicit merge authorization

Merging is never automatic — not even when every check is green. Only after the owner has
explicitly said to merge a specific pull request:

```bash
AYVO_GH_ALLOW_MERGE=<pr-number> /opt/ayvo/bin/ayvo-gh pr merge <pr-number> --merge
```

The variable must name exactly that PR; it applies to that one command only. Claude Code sessions
follow the same rule (CLAUDE.md: no merges without explicit owner approval).

Merges always obey GitHub's branch protection, rulesets and required checks: the wrapper refuses
`--admin` (the bypass flag) and any write through `gh api`, and the App has no Administration
permission, so it cannot change protection rules. Do not add the App to a ruleset's bypass list.

## CI (GitHub Actions)

`.github/workflows/ci.yml` (workflow **CI**) runs on every pull request into `main` and on every
push to `main`. **CI only checks; it never deploys**, never uses repository secrets, the GitHub App
key or deployment credentials, and never reaches the DEV preview, production or their databases.

| Check     | Covers                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality` | `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`                                         |
| `test`    | `pnpm test`: shared types, shared UI, API (unit + integration against PostgreSQL), web unit tests                                          |
| `e2e`     | `pnpm build` + `pnpm test:e2e`: Playwright (Chromium) against the built API (port 4100, fresh `ayvo_e2e` database) and web app (port 3100) |

- **Disposable infrastructure only:** `test` and `e2e` get their own PostgreSQL 18 and Redis 8
  service containers, created for the job and destroyed with it (credentials are throw-away
  values in the workflow, not secrets). A guard step fails the job if a `.env` file exists or the
  database URL is not the job's own `localhost` service. The test suites create and drop
  `ayvo_test_<random>` / `ayvo_e2e` databases on that service only.
- **Versions:** Node from `.nvmrc`, pnpm from `package.json` `packageManager`, frozen lockfile.
  `turbo.json` passes `AYVO_TEST_DATABASE_URL`, `AYVO_SKIP_DB_TESTS`, `REDIS_URL` (and for e2e `CI`,
  `PLAYWRIGHT_*`) through Turborepo's strict environment mode.
- **Token and actions:** `permissions: contents: read`; checkout without persisted credentials;
  third-party actions pinned to full commit SHAs (version in a comment). Runs of a pull request are
  cancelled when a newer push arrives; runs on `main` always complete.
- **Artifacts:** only when `e2e` fails, `playwright-results` (`apps/web/test-results/`, error
  context per failed test) is uploaded and kept for 7 days. Unit and integration failures are in
  the job log.

### Required checks

All three — `quality`, `test`, `e2e` — should be required in the **Protect main** ruleset once
they have passed on the bootstrap pull request: Settings → Rules → Rulesets → Protect main →
**Require status checks to pass** → add `quality`, `test`, `e2e` (source: GitHub Actions). Keep the
job names stable; renaming a job silently drops its requirement.

### Investigating a failure

1. `ayvo-gh pr checks <number>` shows which check failed; `ayvo-gh run list` and
   `ayvo-gh run view <run-id> --log-failed` show the failing step's log (read-only).
2. For `e2e`, download the `playwright-results` artifact from the run page.
3. Reproduce locally (DEV server, `pnpm infra:up`): `pnpm format:check`, `pnpm lint`,
   `pnpm typecheck`, `pnpm build`, `pnpm test`, then `pnpm test:e2e` after a build.

### Workflow files and the App

The App deliberately has **no `Workflows` permission**: it cannot create or change files under
`.github/workflows/`. Workflow changes reach GitHub through the SSH push, and a pull request that
adds or changes a workflow file is merged **by the owner in the GitHub UI** (GitHub refuses such a
merge from an App without `Workflows: write`). All other pull requests can be merged through
`ayvo-gh` with explicit authorization, as before.

## Server files

| Path                                           | Mode | Content                                                                           |
| ---------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| `/opt/ayvo/bin/`                               | 755  | Owned by `ayvo`; not writable by others                                           |
| `/opt/ayvo/bin/ayvo-gh`                        | 755  | Copy of `scripts/ayvo-gh`; SHA-256 must match the reviewed repository version     |
| `/opt/ayvo/secrets/github-app/`                | 700  | —                                                                                 |
| `/opt/ayvo/secrets/github-app/app.env`         | 600  | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_REPOSITORY=ElDiemo/AyvoOS` |
| `/opt/ayvo/secrets/github-app/private-key.pem` | 600  | The App private key (PEM)                                                         |

App ID and Installation ID are not secrets, but they live only on the server (never in Git).
The GitHub CLI comes from GitHub's official apt repository (`https://cli.github.com/packages`,
keyring `/etc/apt/keyrings/githubcli-archive-keyring.gpg`).

## Installation (one-time)

1. **GitHub CLI** (owner, needs sudo): add GitHub's apt repository and install `gh`
   ([official instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)); verify
   the keyring fingerprint against that page. Never run `gh auth login`.
2. **Wrapper:** `install -d -m 755 /opt/ayvo/bin` and
   `install -m 755 scripts/ayvo-gh /opt/ayvo/bin/ayvo-gh`; compare `sha256sum` of both files.
3. **Config:** `install -d -m 700 /opt/ayvo/secrets/github-app`; `app.env` (mode 600) with the
   three keys, IDs empty until the App exists.
4. **Register the App** (owner, GitHub → Settings → Developer settings → GitHub Apps → New GitHub
   App): name `AYVO Automation`, homepage `https://github.com/ElDiemo/AyvoOS`, webhook **inactive**,
   the permissions above, "Only on this account".
5. **Install** it on `ElDiemo` with **Only select repositories → AyvoOS**.
6. **Private key:** generate it on the App page; copy the downloaded `.pem` straight to
   `/opt/ayvo/secrets/github-app/private-key.pem` with `scp` (never through chat, e-mail or a
   ticket), `chmod 600`, then delete the downloaded copy.
7. **IDs:** put the App ID into `app.env`; `ayvo-gh --discover-installation` lists the
   installation; put its ID into `app.env`.
8. **Verify:** `ayvo-gh --whoami` must show `repository_selection: "selected"`, exactly
   `["ElDiemo/AyvoOS"]` and the permissions above.

## Audit

- **On GitHub:** everything the App does is attributed to the app's bot account (PR author,
  comments, merge event); the installation and its permission changes are visible under
  Settings → Applications → Installed GitHub Apps, and in the account's security log.
- **On the server:** `ayvo-gh --whoami` prints the app, installation, repository selection,
  installation permissions, the accessible repositories and the permissions actually granted to a
  token — never a credential. The wrapper keeps no local log; GitHub's records are the audit trail.

## Recovery

- **Server rebuilt / wrapper missing:** reinstall from `scripts/ayvo-gh` (step 2) and compare the
  SHA-256 with the repository version; recreate the config (step 3) and place a **new** private
  key (rotation below) — never copy keys between machines through other channels.
- **Private key lost:** generate a new one on the App page (rotation); the App and installation
  stay as they are.
- **`HTTP 401: A JSON web token could not be decoded` / `…bad credentials`:** wrong App ID, wrong
  key or a revoked key, or the server clock is off (`timedatectl`).
- **`HTTP 404` on access tokens:** wrong Installation ID or the App was uninstalled
  (`ayvo-gh --discover-installation`).

## Private-key rotation

1. GitHub → App settings → **Generate a private key** (the old key keeps working meanwhile).
2. `scp` the new `.pem` to `/opt/ayvo/secrets/github-app/private-key.pem.new`, `chmod 600`.
3. `mv private-key.pem.new private-key.pem` (atomic replace) and run `ayvo-gh --whoami`.
4. **Delete the old key** on the App page (match it by the SHA-256 fingerprint GitHub shows;
   `openssl rsa -in private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64`
   prints the local key's fingerprint).
5. Delete every downloaded copy. Rotate at least yearly and immediately after any suspicion.

## Revocation (incident)

Fastest first, each step independent:

1. **Delete the private key(s)** on the App page — no new tokens can be minted.
2. **Suspend or uninstall** the installation (Settings → Applications → Installed GitHub Apps →
   AYVO Automation → Suspend / Uninstall) — existing installation tokens stop working.
3. Review the repository: PRs, comments, merges and pushes by the app's bot account.
4. Remove the key file from the server and investigate the server account.

## Removing the integration completely

1. GitHub: uninstall **AYVO Automation**, then delete the App (App settings → Advanced → Delete).
2. Server: remove `/opt/ayvo/secrets/github-app/` (after copying nothing out of it) and
   `/opt/ayvo/bin/ayvo-gh`.
3. Optionally remove the GitHub CLI and its apt source (`/etc/apt/sources.list.d/github-cli.list`,
   `/etc/apt/keyrings/githubcli-archive-keyring.gpg`).
4. Mark ADR 0018 as superseded or deprecated and update this document.

Git pushes over SSH are not affected by any of these steps.
