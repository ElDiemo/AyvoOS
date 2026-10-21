# ADR 0030: Remove the shared Basic Auth password from the tailnet-only DEV preview

- **Status:** Accepted — explicit owner direction 2026-10-21 (DEV only)
- **Date:** 2026-10-21
- **Supersedes:** only the Basic Auth requirement of ADR 0013 and ADR 0026.

## Decision

DEV requires membership and access in the Tailscale tailnet, followed by normal WorkOS sign-in.
The additional shared HTTP Basic Auth challenge is removed from Caddy. Application authentication,
permissions, session limits, WorkOS, print-agent tokens, TLS and noindex headers are unchanged.
The tailnet-only port bindings, real-peer Caddy check, host firewall guard, NoSNAT check,
split DNS and public ACME-only port 80 exception remain mandatory. This does not make DEV public.

Deployment no longer reads or requests a Basic Auth verification password or its temporary file.
Checks instead assert login HTML, the sign-in redirect, protected API denial without a session,
print-agent denial without a token, health, no Basic challenge, and all existing network checks.
Health and DEV QR passports remain explicitly public **inside the tailnet**, not on the internet.

Existing server env keys can remain unused for a reversible transition; Compose no longer passes
them into Caddy. Existing agents can still connect without reinstalling or changing their token;
new agent installation does not request Basic Auth. Remove obsolete Basic Auth keys from the
agent configuration without changing its token or job journal. Do not print secrets.

## Delivery and rollback

Use the normal `scripts/deploy-dev.sh --edge`: a verified backup of running Caddy is mandatory,
then only the edge changes. No build, migration, application change, stock operation or print.
Verify from a tailnet device without any Authorization header, and check that public IPv4/IPv6
still cannot reach HTTPS. An edge rollback can restore the previous shared password challenge;
it must not remove the VPN restriction. Old edge backups retain their original requirements.

For physical acceptance a valid application session is still required. Removing Basic Auth does
not authorize creating sessions, bypassing WorkOS, reading browser cookies, or adding test data.
