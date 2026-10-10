# ADR 0012: Turborepo agent guidance disabled; CLAUDE.md is canonical

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO owner, AYVO OS lead architect

## Context

Turborepo 2.11 automatically writes (and re-adds) a managed block in
`AGENTS.md` at the repository root whenever it detects that it is run by an
AI agent. This created a second, tool-controlled AI instruction file next to
`CLAUDE.md`, with content AYVO does not control.

## Decision

- Set `"agentGuidance": false` in the root `turbo.json`.
- Delete the generated `AGENTS.md`.
- `CLAUDE.md` is the **single canonical AI instruction file** for this
  repository.

## Consequences

### Positive

- One source of AI/contributor instructions, owned by AYVO.
- No unexpected uncommitted changes after agent-run `turbo` commands.

### Negative

- The Turborepo hint is lost: Turborepo behaviour can differ from an
  agent's training data. Agents changing Turborepo configuration or
  commands should read the docs bundled with the installed package
  (`node_modules/turbo/docs`) first. This guidance belongs in `CLAUDE.md`.

## Alternatives considered

- **Keep `AGENTS.md` committed** — rejected: duplicates and competes with
  `CLAUDE.md`.
- **Delete `AGENTS.md` without opting out** — rejected: Turborepo would
  re-create it on the next agent invocation.
