# Hotel portal: the hotel profile

The first step of the owner's portal priority (2026-11-09). First the hotel sees and edits its own
profile; contracts and deliveries follow in later PRs. The runtime and data boundaries of the
portal are those of ADR 0045 (PR #127) and of the merged portal stack.

## What exists on a hotel (Core, `hotels`)

| Group                   | Fields                                                                                          | In the portal                |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| Identity                | `id`, `serial`, `code`, `name`                                                                  | name shown, read only        |
| Delivery address        | `address_line1`, `address_line2`, `postal_code`, `city`, `country_code`                         | editable, except the country |
| Main contact            | `contact_name`, `contact_phone`, `contact_email`                                                | editable                     |
| Goods receipt (doc 032) | `receiving_contact_name`, `receiving_contact_phone`, `receiving_contact_email`, `delivery_note` | editable                     |
| Operations              | `fulfillment_site_id`, `created_at`, `created_by`, `operation_request_id`                       | never shown or changed       |

Billing data (payer, legal name, IČO/DIČ, billing address and e-mail) lives in Finance's customer
versions, not on the hotel, and is not part of this profile. Grants, orders, shipments and issued
documents are not touched.

## Rules

- **Who:** any portal account with an active grant that names the hotel. Every other hotel id is
  "not found", the same as a missing one.
- **What:** only the eleven whitelisted fields (`hotelProfileFieldsSchema`, strict). The same
  limits as creating a hotel and "Upravit praktické údaje". Any other key is refused by portal-web
  and again by the core.
- **One source of truth:** the core's `HotelsService` reads and writes the existing hotel row. The
  staff detail shows the same values. Nothing is copied and nothing crosses into Finance.
- **Orders keep their snapshot:** an order copies the name, address and main contact when it is
  created (doc 028). A profile change applies to orders created afterwards. Existing orders and
  their shipments stay as they are.
- **Concurrency:** the profile carries a fingerprint of its values. A save from older values is
  refused (`409 PROFILE_STALE`) instead of overwriting another account's change. The same values
  saved again change and audit nothing.
- **Access is checked again in the write:** in one transaction the core takes the account's row
  lock, the lock a grant revocation or a deactivation takes first. It then re-reads the session and
  the active grant on this hotel. A revocation that committed before is seen. One that comes later
  waits for the save.
- **CSRF:** portal-web refuses a request that does not come from the portal origin. The core
  checks the forwarded browser request again.
- **Audit:** `HOTEL_UPDATED` with the portal account as actor, the hotel's serving site, the
  required reason, `via: PORTAL`, the grant and the changed fields before and after.

## portal-web

- `/hotels/<id>`: a hero card (name, city and country) and three groups (delivery address, main
  contact, goods receipt) with empty states.
- `/hotels/<id>/edit`: a normal form in three fieldsets. It is validated in the browser with the
  same schema, shows an error summary that takes the focus, and supports keyboard-only use.
- `POST /hotels/<id>/profile`: portal-web's only state-changing route outside `/auth/*`. It
  accepts at most 8 KiB, read within 5 s, with 4 saves in flight. It is not behind the CSP proxy
  (no body buffering) and answers JSON with the script-free policy.
- The navigation shows only finished sections ("Moje hotely", "Faktury").

## Edge

The DEV edge proxies POST only to `/auth/*` and caps every body at 4 KiB. The profile save
therefore needs an explicit allowlist for exactly `POST /hotels/<uuid>/profile` with 8 KiB and the
same read timeouts. That change is a separate, follow-up draft PR. Until both are deployed, a save
behind the DEV edge answers 405 and nothing changes.

## Owner decisions (2026-11-09)

1. **The hotel name stays read only** in the portal; AYVO changes it. The country is read only
   too.
2. **Every account with a grant on the hotel may edit** the profile. In practice the hotel's
   manager holds the access, so no read-only portal account is added.
3. **A reason is required** for every save, so AYVO knows why. It is kept in the audit event's
   `reason` together with the account, the grant and before/after. Saving the same values again
   is still a no-op.
4. **No notification** to staff. An address change applies only to orders created afterwards;
   existing orders and their shipments keep their snapshot. The audit with its reason is the
   record.
