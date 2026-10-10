# ADR 0009: Prisma as ORM and migration tool

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

The API needs type-safe database access to PostgreSQL (ADR 0002),
versioned migrations, and support for transactions spanning several
records. Some required invariants (partial unique indexes, exclusion and
check constraints, permission revokes on append-only tables) go beyond what
an ORM schema language can express.

## Decision

- Use **Prisma 7** in `apps/api`:
  - `prisma/schema.prisma` for the data model,
  - `prisma.config.ts` for configuration (schema path, migrations path,
    datasource URL from environment),
  - the **`@prisma/adapter-pg` driver adapter** for runtime connections.
- **Migrations are committed** to the repository and reviewed like code.
- **Raw SQL in migrations is allowed and expected** for constraints Prisma
  cannot express: partial unique indexes (e.g. one active crate membership
  per bottle), `CHECK` and exclusion constraints, triggers, and
  `REVOKE UPDATE, DELETE` on event/audit tables (ADR 0006).
- Multi-record business operations use interactive transactions
  (`$transaction`) with appropriate isolation/locking; raw SQL queries are
  allowed where Prisma's query API is insufficient (e.g. `FOR UPDATE`).
- Prisma access is wrapped in a NestJS `PrismaService`; domain modules do not
  share or leak the client outside their repositories.
- Production uses `prisma migrate deploy` only (ADR 0008).

## Consequences

### Positive

- Generated types aligned with the schema; good developer experience.
- Migration history is explicit and reviewable.
- Driver adapter uses the standard `pg` driver.

### Negative

- Constraints written in raw SQL are invisible in `schema.prisma`; they must
  be documented in the schema with comments.
- Prisma releases move quickly; upgrades need care.
- Complex reporting queries may need raw SQL.

## Alternatives considered

- **Drizzle ORM** — closer to SQL, good option; Prisma chosen per stack
  decision and team familiarity.
- **TypeORM / MikroORM** — weaker type safety or more runtime magic.
- **Raw SQL + query builder (Kysely)** — more boilerplate for CRUD-heavy
  admin modules.
