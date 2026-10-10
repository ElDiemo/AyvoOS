# 007 — Hotels and Contracts

This document describes the hotel/customer master data and contracts AYVO OS must manage, and how they relate to logistics and billing.

Status: Draft — foundation phase (2026-10-10)

## Confirmed requirements

AYVO OS needs a proper hotel/customer master database. Each hotel may eventually contain:

- company
- hotel name
- locations
- billing information
- shipping addresses
- contacts
- contracted room count
- price per room per month
- billing cycle
- payment terms
- active products
- service frequency
- target stock levels
- minimum stock levels
- preferred carrier/service
- operational notes
- delivery history
- return history
- invoices
- sustainability data

Hotel configuration must be editable by **authorized AYVO administrators**.

## Proposed design (requires confirmation)

### Entities and ownership (customers module)

| Entity               | Key fields (proposal)                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Company              | legal name, registration/VAT IDs, billing address, billing contact                                              |
| Hotel                | name, company, status, operational notes                                                                        |
| HotelLocation        | name, shipping address, city, region, country, delivery instructions                                            |
| Contact              | name, role, email, phone, linked hotel/location                                                                 |
| Contract             | hotel, valid_from, valid_to, contracted_rooms, price_per_room_per_month, currency, billing_cycle, payment_terms |
| ServiceConfiguration | hotel(+location?), product, active, target_stock, minimum_stock, service_frequency, preferred carrier/service   |

Delivery history, return history, invoices and sustainability data are **not** stored on the hotel; they are owned by the deliveries, returns, billing and sustainability modules and queried by hotel.

### Versioning instead of overwriting

- Contracts are **effective-dated**: a change creates a new contract version (or amendment) with `valid_from`; old versions remain. Billing reads the version valid for each period.
- Addresses used on deliveries are snapshotted on the delivery so later edits do not rewrite history.
- All administrative edits are written to the audit log (actor, timestamp, before/after).

### Access

- Only authorized AYVO administrators can edit hotel configuration (roles in [012](012-security.md)).
- Hotel users may view (not edit) a limited subset of their own hotel's data via the portal; exact subset is open.

### Relationship to other modules

- service-planning reads ServiceConfiguration (target/minimum stock, frequency).
- billing reads Contract versions ([010](010-billing.md)).
- deliveries reads HotelLocation and preferred carrier.

## Open questions

- Company ↔ hotel cardinality; can one invoice cover several hotels?
- Is the contract per hotel or per location? Can locations have separate configurations?
- Can contract room counts change mid-period, and how is that billed (see prorating in [010](010-billing.md))?
- Billing cycle options (monthly only?), payment terms options.
- Is service frequency a fixed schedule (e.g. every N days/weekly) or rule-based?
- Required fields and validation rules (VAT ID formats, address formats per country).
- Can hotel users edit any data (e.g. contacts, inventory counts)?
