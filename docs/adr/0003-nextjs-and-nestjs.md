# ADR 0003: Next.js + NestJS in a TypeScript monorepo

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

AYVO OS needs an internal admin/warehouse UI (including scan-driven
workflows on tablets or handheld devices), a hotel portal, a public bottle
passport and a backend API with transactional business logic. A single
language across frontend and backend reduces context switching and lets us
share types and validation.

## Decision

- **Language:** TypeScript (6.0) everywhere, in strict mode.
- **Monorepo:** pnpm workspaces + Turborepo 2.
  - `apps/web` — Next.js 16 (App Router, React 19), Tailwind CSS 4,
    shadcn/ui where appropriate.
  - `apps/api` — NestJS 12 (ESM), hosting the modular monolith (ADR 0001).
  - `packages/types` — shared API contracts as **Zod 4** schemas, with
    TypeScript types inferred from them. Used by the API for validation and
    by the web app for typed calls.
  - `packages/ui` — shared UI components.
  - `packages/config` — shared TypeScript / ESLint / Prettier config.
- **Business logic lives in the API only.** The web app is a client of the
  API; it does not access the database directly. Next.js server features
  may be used for rendering and as a thin proxy, not for domain logic.
- **Testing:** Vitest for unit/integration tests, Playwright for end-to-end.

## Consequences

### Positive

- One language, one toolchain, shared contracts — fewer integration bugs.
- NestJS's module system maps naturally to the modular monolith.
- Next.js supports internal UI, hotel portal and public passport pages in
  one app (separable later if needed).
- Turborepo caches builds/tests across the workspace.

### Negative

- Two frameworks to keep up to date; major versions move quickly.
- NestJS relies on decorators and runtime metadata, which requires care in
  test tooling (SWC transform for Vitest).
- Keeping all logic in the API means the web app needs an extra network hop
  for every data access.

## Alternatives considered

- **Next.js only (route handlers / server actions as backend)** — rejected:
  mixes UI and domain logic, weaker structure for a large transactional
  domain, harder to expose a clean API to carriers, devices and the portal.
- **Separate repos for web and API** — rejected: harder to share contracts
  and keep changes atomic.
- **Other backend languages (Go, Java, Python)** — rejected for now: lose
  shared types; the team standardises on TypeScript.
- **npm/yarn workspaces, Nx** — pnpm + Turborepo is simpler and sufficient.

## Open questions

- Whether the hotel portal and public passport should later be separate
  Next.js apps (security isolation, separate domains).
