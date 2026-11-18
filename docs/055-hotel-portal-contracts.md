# Hotel portal: signed contracts (read only)

The second step of the owner's portal priority (2026-11-09), after the profile (doc 053). A hotel
sees its contracts, but only an approved, signed document of its own. It never sees a draft.

## What the portal shows

- Only **signed originals** (`contract_signed_documents`, ADR 0043 §6, doc 045 §7) of drafts
  linked to a hotel the session holds an active grant on.
- A signed draft keeps its hotel for good: the DB never lets it be removed or relinked. A draft
  linked only to a prospect has no hotel and never appears.
- Drafts, revisions without a signed original, the working template, prices, the counterparty
  and internal codes are never offered.
- Per document: the signing date, the start of the service named by the signed revision, and the
  PDF size. The PDF is downloaded exactly as AYVO uploaded it; its SHA-256 is checked before it is
  sent.

## Core contract

- `GET /api/internal/v1/portal/hotels/:id/contracts`: the list, newest first. A hotel not granted
  to the session answers 404.
- `GET /api/internal/v1/portal/contracts/:id/pdf`: the file, if its draft's hotel is granted to the
  session **now**; any other id answers 404. It is sent with `private, no-store`, `nosniff` and a
  sandboxed CSP, under the name `AYVO-smlouva-<signed date>.pdf`.
- Each download is recorded as `SIGNED_DOWNLOADED` on the draft, with the portal account as actor
  and `details.via = PORTAL`.
- The contracts module (`ContractDraftsService`) owns both reads. The portal only checks the
  session and the grants, through its reserved pool.

## portal-web

- A "Smlouvy" card on the hotel page, with an empty state. When the core does not answer, the card
  says so and the profile stays.
- `GET /contracts/<id>/pdf` uses the same pass-through as the invoice PDF (`lib/pdf-proxy.ts`): one
  20 s deadline, a PDF in-flight budget, header checks and counted bytes, up to 20 MB (the core's
  upload limit). It is not behind the CSP proxy.
- No new navigation item: contracts belong to their hotel.

## Notes

- Editing the hotel's address in the portal (doc 053) does not touch signed contracts. A draft
  that is not yet signed and names the old address will hit the existing
  `HOTEL_NOT_SIGNED_REVISION` check at signing. Staff then revise the draft, as for any hotel
  change.
- The edge already proxies GET, so no edge change is needed.
