# ADR 0045: Hotel portal — first cut as its own unit behind explicit contracts

- **Status:** Proposed — owner priority 2026-11-05 (issue #125, part 2), for the owner's approval
  before any implementation. No table, permission, host or edge in this ADR exists. (ADR 0044 is
  taken by the QR presentations proposal, PR #123.)
- **Date:** 2026-11-05
- **Context:**
  - **No portal exists.** `HOTEL_USER` is a planned, unassignable role with no permissions
    (`packages/types/src/identity.ts:27`, `users.service.ts:475`). The hotel scope types
    `HOTEL_ORGANIZATION`/`HOTEL_SITE` exist (`schema.prisma:1363`), but nothing evaluates them
    (`access.service.ts:37`).
  - **Required rules.**
    - Doc 040 §14 requires access granted explicitly per billing payer and its hotels. A right to
      one hotel never reveals a payer's other invoices, and every list, detail and PDF is checked
      on the server.
    - Doc 021 §4c: a separate external shell; never warehouse, production, cost or administration
      access; internal and hotel roles are never combined on one account.
    - ADR 0038 (proposed, PR #65): new units such as the portal are built separately from the
      start, with per-request session introspection.
  - **Finance boundary.** Finance owns invoices and payment state (`prisma-finance`). Payment
    state is derived from allocations (`payments.service.ts:60`). Finance calls only the core,
    never the other way round (ADR 0039).
  - **Exposure today.** The internal OS is tailnet only (ADR 0026/0033). The existing public edges
    (QR, ID, marketing) are anonymous and stateless.

## Decision

1. **Its own unit.**
   - A `portal` API process (`node dist/portal/main.js`, built from `apps/api` like Finance) and
     its own Next app `apps/portal`. The internal `apps/web` is never served to the internet.
   - The portal unit owns **no business data**. It holds no DB role on the core or Finance
     schemas and keeps no copy of hotels or invoices.
2. **Identity: the existing native identity of the core, a separate kind of user.**
   - Portal users are core `users` with role `HOTEL_USER` only. It is never combined with an
     internal role (DB CHECK), and invitations are issued by an AYVO ADMIN.
   - Sign-in is the same native flow (password + TOTP, ADR 0037), served through the portal.
   - The portal session is its own cookie `ayvo_portal_session` on the portal host, with its own
     policy. It is never valid on the internal app, and an internal session is never valid on the
     portal.
   - The session is introspected at the core on every request (ADR 0038 §5); revocation takes
     effect on the next request.
3. **Access model (core identity, new table — for approval):**
   ```
   portal_grants   user (HOTEL_USER), payer = Finance customer id (no FK, validated through
                   the Finance contract when granted), granted_at/by, revoked_at/by/reason
   portal_grant_hotels   grant, hotel (FK hotels)
   ```
   - Visible hotels are the hotels of the user's active grants.
   - **An invoice is visible only if its payer is a granted payer and every hotel on its lines is
     granted under that payer.** A summary invoice is therefore never revealed by one hotel.
   - Revoking a grant, or deactivating the user, also ends their portal sessions.
4. **Explicit contracts, no foreign tables.**
   - Core → portal (`/api/internal/v1/portal/*`, service token):
     - session introspection, which returns the user and grants;
     - the user's hotels (name, address, contacts, receiving details);
     - the allowed contact changes;
     - invitation and sign-in steps.
   - Finance → portal (`/api/internal/v1/portal/invoices*` on Finance):
     - list, detail and PDF for the forwarded portal session;
     - Finance resolves the grants at the core itself, per request (as for staff today, ADR
       0039), and never trusts a scope sent by the portal;
     - it returns only the issued invoice snapshot, the number, the dates, the total, the payment
       state `UNPAID | PARTIALLY_PAID | PAID` and the PDF.
   - Finance down: the portal shows invoices as unavailable, and the hotel data keep working.
5. **The first cut (P1), nothing more:**
   - invitation, sign-in and revocation;
   - "Moje hotely" (own hotels and details, read);
   - "Faktury" (own invoices, state, PDF);
   - **contact changes limited to exactly these fields of an own hotel:**
     - `contactName`, `contactPhone`, `contactEmail`;
     - `receivingContactName`, `receivingContactPhone`, `receivingContactEmail`;
     - `deliveryNote`.
   - Each contact change carries a reason, is audited with the portal user as actor and shown to
     AYVO.
   - Name, address, fulfilment site, payer, billing e-mail, prices, terms and issued invoices
     never change from the portal.
   - Not in P1:
     - the ZIP of a period (backlog, doc 040 §14);
     - hotel groups;
     - ESG;
     - orders;
     - overdue wording (doc 040 §14.5, waits for the owner).
6. **Exposure.**
   - DEV: the portal runs tailnet-only (ADR 0026) on its own port/host, so the first usable output
     needs no DNS or edge change.
   - PROD: a separate `portal-edge` reaches only `portal-web`. It never reaches the internal web,
     the API or `/api/internal/*`. The edge, its host and DNS need a separate owner approval and
     Codex (doc 040 §14.1).
   - The portal ships in its own containers and is deployed on its own.
7. **Labels.** On DEV, the invoices shown are `TEST` invoices and are labelled so. Nothing calls
   them live invoicing (doc 040 §13).

## Consequences

- New migration in the core for `portal_grants` (+hotels), the `HOTEL_USER` CHECK, the portal
  permission set (`portal:*`, held only by `HOTEL_USER`) and the portal session kind. New contract
  routes in the core and in Finance; a new process and Next app.
- Tests required:
  - **Isolation of two customers** (two payers, a shared chain with a summary invoice) on every
    path: list, detail, PDF and the hotel detail.
  - **Revocation** mid-session.
  - **Sessions:** a staff session refused on the portal, and a portal session refused on the
    internal API.
  - **Contact changes:** only the listed fields accepted.
  - **Finance down.**
- **Open for the owner:**
  - the portal languages (cs/en/de, following the payer's document language?);
  - whether a hotel user may change contacts directly, or only propose a change that AYVO
    confirms (P1 proposes direct, audited);
  - the PROD host name.
