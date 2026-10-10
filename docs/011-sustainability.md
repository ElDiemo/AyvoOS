# 011 — Sustainability, ESG and the Public Bottle Passport

This document describes the sustainability data AYVO OS may present — to hotels (ESG exports) and to guests (public bottle passport) — and the rule that only verified, methodology-backed figures may be shown.

Status: Draft — foundation phase (2026-10-10)

## Confirmed requirements

- A guest/customer scanning a bottle QR should eventually see a **public bottle passport**.
- Possible verified information: bottle identifier, product, number of completed reuse cycles, lifecycle statistics, sustainability information.
- A **completed reuse cycle** means the bottle was delivered to a hotel and was subsequently returned and individually identified by AYVO _(confirmed by owner 2026-10-10)_. See [004](004-bottle-lifecycle.md#reuse-cycle-count).
- The public QR identity is opaque and practically unguessable, separate from the internal ID, and public QR URLs remain stable for the physical lifetime of the bottle _(confirmed by owner 2026-10-10)_.
- **Do not invent CO2 savings.** CO2e may only be shown once AYVO has a **documented methodology**.
- Hotels will eventually see bottle circulation metrics, sustainability data and ESG exports in their portal.

## Proposed design (requires confirmation)

### Principle: facts first, derived claims later

| Category             | Examples                                                               | Allowed when                                      |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Observed facts       | reuse cycles, wash cycles, deliveries, returns, bottles in circulation | Derived directly from lifecycle events            |
| Derived metrics      | single-use bottles avoided                                             | Definition documented and approved by AYVO        |
| Environmental impact | CO2e, water, waste mass                                                | Documented methodology approved; version recorded |

- Every derived/impact figure stores the **methodology version** used, so reports remain reproducible after methodology changes.
- Until a methodology exists, the system exposes no CO2e fields at all (no placeholder numbers).

### Public passport

- Read-only endpoint resolved by the bottle's public QR identity (never the internal ID); the URL stays stable for the bottle's physical lifetime, including after retirement or disposal (what such a page shows then is open).
- Exposes an **explicit whitelist** of fields; never hotel identity, locations, customers, internal IDs or operator data unless AYVO explicitly decides otherwise.
- Rate-limited; cached (Redis, non-authoritative).
- See [012 — Security](012-security.md) for enumeration concerns.

### Hotel ESG exports

- Scoped strictly to the requesting hotel.
- Based on the hotel's deliveries, returns and bottles circulated through it in a period.
- Export format (CSV/PDF/standard framework) is open.

## Open questions

- CO2e (and any other impact) methodology, sources, verification/third-party review.
- Which fields may the public passport show (e.g. city/country where used? hotel name?).
- ESG reporting frameworks hotels need (e.g. CSRD-related data points?) and export formats.
- Languages and branding of the public passport page.
