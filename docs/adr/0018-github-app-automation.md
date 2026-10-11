# ADR 0018: GitHub automation through a repository-scoped GitHub App

- **Status:** Accepted — confirmed by owner 2026-10-11
- **Date:** 2026-10-11
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** —

## Context

The DEV server pushes branches over SSH (a key that can push but cannot use the GitHub API).
Opening and updating pull requests, reading checks and — only when the owner says so — merging
required manual copying in the browser. The owner wants this automated without a human GitHub
session and without personal access tokens, and with merges that never happen on their own.

## Decision

- A dedicated GitHub App, **AYVO Automation**, owned by the `ElDiemo` account, webhook disabled,
  installed **only on the `ElDiemo/AyvoOS` repository**, with repository permissions Metadata
  (read), Contents (read & write), Pull requests (read & write), Checks (read), Commit statuses
  (read), Actions (read). No organization or account permissions; no Administration, Secrets,
  Workflows or Members.
- The server authenticates **as the App installation**: a short-lived App JWT signed with the
  App's private key mints an installation token per call, restricted to AyvoOS and down-scoped to
  the call (only an authorized merge gets `contents: write`), handed only to the invoked `gh`
  process and revoked when it exits. Nothing but the private key is long-lived.
- The single entry point is the wrapper `scripts/ayvo-gh` (installed as `/opt/ayvo/bin/ayvo-gh`)
  with an allow-list of operations and a **per-PR explicit merge authorization**
  (`AYVO_GH_ALLOW_MERGE=<number>`). There is no auto-merge.
- Secrets stay on the server under `/opt/ayvo/secrets/github-app/` (700/600), never in Git.
- The existing SSH remote and push access are unchanged.

Details, threat model, rotation, revocation and removal: [doc 017](../017-github-automation.md).

## Consequences

### Positive

- Pull requests can be created and maintained from the server with a clear, non-human identity.
- A leaked installation token is useless after the call (revoked) and limited to one repository.
- Least privilege per call; merges need a deliberate, PR-specific step.

### Negative

- The App private key on the server is a standing credential: whoever controls the server
  account can act as the App on AyvoOS within its permissions, including pushing via
  `contents: write`. Branch protection on `main` (owner setting) and key rotation/revocation
  mitigate this.
- One more component to maintain (GitHub CLI package, wrapper, key rotation).

## Alternatives considered

- **Personal access token (classic or fine-grained)** — rejected: tied to a person, long-lived,
  easy to leak or over-scope.
- **`gh auth login` (OAuth, human session)** — rejected: acts as the owner with the owner's full
  rights; stored token on the server.
- **SSH deploy key** — cannot create pull requests or read checks (Git protocol only).
- **GitHub Actions with `GITHUB_TOKEN`** — does not act from the server on demand; would need the
  Workflows permission and CI design that does not exist yet (no CI/CD, ADR 0013).
