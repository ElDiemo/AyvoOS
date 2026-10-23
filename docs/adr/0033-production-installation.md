# ADR 0033: Production installation on AyvoOS-PROD — the same release, separate everything else

- **Status:** Proposed — prepared at the owner's request 2026-10-22 (clarified 2026-10-23); not
  installed
- **Date:** 2026-10-23
- **Continues:** [0008](0008-dev-prod-separation.md), [0013](0013-dev-preview-deployment.md),
  [0026](0026-dev-preview-tailnet-only.md), [0030](0030-dev-preview-without-basic-auth.md);
  storage [0032](0032-production-private-s3-storage.md) (#47)

## Context

The owner wants the first real acquisition records (Obchod) in production on a separate VPS
(AyvoOS-PROD). DEV must never hold production data or secrets (ADR 0008), and production must not
become a different product.

## Decision

- **One application.** Production runs the code of one approved release commit — a commit already
  on `origin/main` — exactly as DEV runs it. No production-only mode, feature switch, module
  blocking or navigation of its own. What a person sees follows their roles (a salesperson: `SALES`
  → Obchod only).
- **Separate installation.** Its own Compose project `ayvo-prod`, images `ayvo-prod/*:<release>`,
  volumes `ayvo-prod-*`, database (created only by the migrations — never a DEV copy or test
  seed), Redis, server-only env files, and its own deploy script `scripts/deploy-prod.sh`.
  `deploy/dev` stays DEV's.
- **Internal network, as DEV.** `os.ayvo.co` only through the Tailscale tailnet: HTTPS and the
  private DNS on the Tailscale IPv4, a real-peer check in Caddy (`100.64.0.0/10`, never the Docker
  gateway), Tailscale SNAT off, a host guard in `DOCKER-USER` for IPv4 and IPv6, and the public
  IPv4 :80 exception for ACME HTTP-01 only. Normal WorkOS sign-in with MFA; no Basic Auth.
- **Start conditions are met, not bypassed.** Production starts only with the application's own
  production checks satisfied: S3 file storage (ADR 0032), WorkOS production and the production QR
  base URL (ADR 0014). The physically validated QR settings are not a start condition: without
  them only our QR label operations are refused (ADR 0034). Missing values are manual owner
  steps (doc 036 §8); none gets a placeholder.
- **Data safety.** A verified dump (and S3 backup, doc 035) before every migration of a non-empty
  database; never `down -v`, volume removal or prune; never an automatic restore.

## Consequences

- Until the physical QR validation is recorded, production runs, but our QR labels cannot be
  created or printed (ADR 0034 — replaces the earlier "production does not start").
- A release is a deliberate owner action; DEV may run newer code than production.
- The server builds the images itself (4 GB RAM + swap); a registry would be a new decision.

## Rollback

Production holds no shared state with DEV: stopping it (`docker compose -p ayvo-prod stop`) and
removing the host guard (`deploy/prod/host/uninstall.sh`) return the server to its earlier state;
the data volumes and S3 objects stay until the owner decides otherwise.
