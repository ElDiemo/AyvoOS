# ADR 0001: Modular monolith

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

AYVO OS must cover bottles, crates, filling, warehouse operations, hotels and
contracts, recurring service deliveries, returns, billing, carrier
integration, sustainability reporting, a hotel portal and a public bottle
passport. The team is small, the domain is still being discovered, and many
business operations span several areas at once (for example: completing
picking touches deliveries, crates and bottle lifecycle history). Those
operations must be transactional (see ADR 0002, ADR 0006).

## Decision

We will build AYVO OS as a **modular monolith**:

- One backend deployable (`apps/api`, NestJS) and one web deployable
  (`apps/web`, Next.js), sharing one PostgreSQL database.
- The backend is split into domain modules with explicit public interfaces.
  Proposed modules: `identity-access`, `catalog`, `assets` (bottles, crates,
  QR identities), `production` (fill batches, filling), `warehouse`,
  `customers` (hotels, locations, contracts), `service-planning`,
  `deliveries`, `returns`, `billing`, `sustainability`, `audit`.
- Modules call each other only through exported services / interfaces, never
  by reaching into another module's internals or tables directly.
- Each module owns its tables. Cross-module reads go through the owning
  module's service (or a clearly documented read model).
- Cross-module business operations run inside one database transaction.
- Module boundaries are enforced by convention, code review and, later,
  lint rules on import paths.

## Consequences

### Positive

- Multi-record business operations are plain ACID transactions; no
  distributed transactions, sagas or eventual consistency to manage.
- One codebase, one build, one deployment: simple to operate on a small
  server and for a small team.
- Refactoring boundaries is cheap while the domain is still being learned.
- A well-bounded module can later be extracted if a real need appears.

### Negative

- Discipline is required to keep module boundaries clean; a shared database
  makes it easy to cheat.
- The whole backend scales as one unit (acceptable at expected volumes).
- A defect in one module can affect the whole process.

## Alternatives considered

- **Microservices** — rejected: explicitly out of scope, adds network
  failure modes, distributed transactions and operational overhead with no
  benefit at AYVO's scale.
- **Unstructured monolith** — rejected: would become hard to change as the
  domain grows; boundaries are cheap to set up now.
- **Serverless functions** — rejected: poor fit for transactional,
  stateful warehouse workflows and adds vendor coupling.

## Open questions

- Final module list and naming will be confirmed as each domain is
  implemented.
