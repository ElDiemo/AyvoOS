# ADR 0047 — The hotel portal behind the existing public edge (amends ADR 0045 §7–§8)

Status: **accepted by the owner** (review 5848102779 on #176, 2026-11-10: option A1 and this
amendment). Implementation under review; nothing is deployed by this ADR.

## Context

ADR 0045 §7 placed the public portal on its own `portal-edge` reaching only `portal-web`. On PROD
the only listener on the public IPv4 :443 is the existing public Caddy (`qr-edge`: QR, optionally ID
and marketing), so a second process cannot bind it (doc 064 §1). That Caddy cuts every response at
its server-wide `write 30s`; a host- or route-scoped longer write limit is not possible on the shared
listener — a route's `timeouts { write_timeout }` neither extends the server's limit nor, without
it, bounds a streamed response (isolated test on Caddy 2.11.7 and 2.11.9, doc 064 Appendix A).

## Decision

1. **One public Caddy process, one site and one internal network per public service.** The portal
   is a site of the existing public Caddy (`deploy/prod/sites/portal.caddy`, overlay
   `compose.portal-edge.yml`), reaching only `portal-web` on the internal `portal-edge` network.
   `portal-web` stays its own, separately deployable unit (`compose.portal.yml`), reaching only
   `api` and `finance` on the internal `portal-contracts` network. The public Caddy is a named
   shared failure domain of QR, ID, marketing and the portal.
2. **The public edge's global options are not changed** (`write 30s` and the read, idle and header
   limits stay exactly as they are for QR, ID and marketing).
3. **The invoice package fits under it (A1):** on PROD Finance builds and sends at most 16 MiB
   within 20 s (`FINANCE_PORTAL_PACKAGE_MAX_BYTES`, `…_TIMEOUT_MS`; never above the shared
   ceiling of ADR 0045 / #173) and portal-web ends the package within 25 s
   (`PORTAL_PACKAGE_DEADLINE_MS`). A larger package is refused before sending ("Zvolte kratší
   období"). Finance's deadline lasts until its last byte has left, so the cap is what an
   8 Mbit/s client receives within it: the DEV acceptance (review 5858165597,
   `portal-a1-acceptance.e2e.test.ts`: real Finance, portal-web and Caddy with the public edge's
   options) built a full 16 MiB package and delivered it whole at 8 Mbit/s within the 20 s; at
   20 MiB the transfer took 20.5 s — past Finance's deadline, through only by buffering — hence
   16 MiB, not 20. The edge alone cuts 40 MiB at 30 s. Slower clients get the package cut (by
   Finance at 20 s at the latest); a shorter period helps.
4. **Private first, public last** (doc 064 §3): the portal unit (keys, contracts, `portal-web`) may
   run without any public route; the public site is a separate switch (`PORTAL_PUBLIC=on`).

## Consequences

- An incident on the public Caddy affects QR, ID, marketing and the portal together; the internal
  OS (`os.ayvo.co`, tailnet only) is not on it.
- Packages larger than 16 MiB need a shorter period on PROD; a second public address (option B)
  would allow the full ceiling and needs a new decision.
- ADR 0045 §7's separate `portal-edge` process is replaced by the network of the same name.
