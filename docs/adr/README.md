# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for AYVO OS.
An ADR captures one significant architectural decision: the context, the
decision itself, its consequences and the alternatives that were rejected.

## Process

1. Copy `0000-template.md` to the next free number: `NNNN-short-title.md`.
2. Start with status **Proposed**. Discuss and review it like code.
3. Once agreed, set status to **Accepted** with the date.
4. Never rewrite the decision of an Accepted ADR. If a decision changes,
   write a new ADR that **supersedes** the old one and mark the old one
   `Superseded by ADR NNNN`. Typo fixes and clarifications are fine.
5. Reference ADRs from code reviews and docs when a change touches the
   decision.

Status values: `Proposed`, `Accepted`, `Rejected`, `Deprecated`,
`Superseded by ADR NNNN`.

## Index

| ADR                                                        | Title                                                         | Status                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [0001](0001-modular-monolith.md)                           | Modular monolith                                              | Accepted — confirmed by owner 2026-10-10                                                  |
| [0002](0002-postgresql-source-of-truth.md)                 | PostgreSQL as the source of truth                             | Accepted — confirmed by owner 2026-10-10                                                  |
| [0003](0003-nextjs-and-nestjs.md)                          | Next.js + NestJS in a TypeScript monorepo                     | Accepted — confirmed by owner 2026-10-10                                                  |
| [0004](0004-crate-as-primary-logistics-unit.md)            | Crate as the primary logistics unit                           | Superseded by [0021](0021-crate-capacity-and-circulation-cycle.md)                        |
| [0005](0005-permanent-bottle-identity.md)                  | Permanent bottle identity                                     | Accepted — confirmed by owner 2026-10-10                                                  |
| [0006](0006-auditable-lifecycle-history.md)                | Immutable, auditable lifecycle history                        | Accepted — confirmed by owner 2026-10-10                                                  |
| [0007](0007-separate-billing-from-logistics.md)            | Separate billing from logistics                               | Accepted — confirmed by owner 2026-10-10                                                  |
| [0008](0008-dev-prod-separation.md)                        | DEV / PROD separation                                         | Accepted — confirmed by owner 2026-10-10                                                  |
| [0009](0009-prisma-orm.md)                                 | Prisma as ORM and migration tool                              | Accepted — confirmed by owner 2026-10-10                                                  |
| [0010](0010-redis-non-authoritative.md)                    | Redis is never authoritative                                  | Accepted — confirmed by owner 2026-10-10                                                  |
| [0011](0011-bottle-terminal-states-and-reuse-cycles.md)    | Bottle terminal states and reuse cycles                       | Accepted — confirmed by owner 2026-10-10                                                  |
| [0012](0012-turborepo-agent-guidance-disabled.md)          | Turborepo agent guidance disabled; CLAUDE.md canonical        | Accepted — confirmed by owner 2026-10-10                                                  |
| [0013](0013-dev-preview-deployment.md)                     | DEV preview deployment: Caddy, same-origin API, Basic Auth    | Accepted — confirmed by owner 2026-10-10                                                  |
| [0014](0014-public-qr-identity-and-url.md)                 | Public QR identity, URL format, DEV/production separation     | Accepted — QR size/EC still provisional                                                   |
| [0015](0015-immutable-label-template-versions.md)          | Immutable label template versions, reproducible print jobs    | Accepted — confirmed by owner 2026-10-10                                                  |
| [0016](0016-file-storage-abstraction.md)                   | File storage abstraction                                      | Accepted for DEV; production blocker                                                      |
| [0017](0017-authentication-and-authorization-blocker.md)   | Authentication and authorization (provider not selected)      | Superseded (provider) by [0022](0022-external-oidc-authentication.md); requirements stand |
| [0018](0018-github-app-automation.md)                      | GitHub automation through a repository-scoped GitHub App      | Accepted — confirmed by owner 2026-10-11                                                  |
| [0019](0019-inventory-ledger-and-idempotent-operations.md) | Inventory ledger, protected balances, idempotent operations   | Accepted — confirmed by owner 2026-10-11                                                  |
| [0020](0020-operational-modules-and-application-shell.md)  | Operational modules (Sklad, Výroba) and the application shell | Accepted — directed by owner 2026-10-11                                                   |
| [0021](0021-crate-capacity-and-circulation-cycle.md)       | Crate capacity 40 and the full-circulation crate cycle        | Accepted — confirmed by owner 2026-10-11                                                  |
| [0022](0022-external-oidc-authentication.md)               | External OIDC authentication; authorization in AYVO OS        | Accepted — implemented (doc 021), DEV activation pending WorkOS                           |

ADRs 0003 (Next.js + NestJS stack) and 0009 (Prisma) were confirmed by the
owner on 2026-10-10 as part of the foundation review. ADRs 0004,
0005, 0006 and 0008 were updated on 2026-10-10 to reflect the owner's
confirmed decisions before being marked confirmed.
