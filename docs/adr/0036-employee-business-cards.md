# ADR 0036 — Public employee business cards managed in AYVO OS

Status: proposed implementation for owner review, 2026-10-23.

## Context and owner decision

The existing `id.ayvo.co/<slug>` PHP site reads profiles from a JSON file outside
the document root. The owner wants the same cards managed on the existing user
detail in AYVO OS, including photographs and work contact information. Existing
printed addresses must keep working. The owner explicitly confirmed that only
administrators manage cards, deactivation hides the card, and reactivation does
not republish it.

## Decision

- Identity owns one optional `employee_cards` record per user; it is not a new
  employee directory or HR module. The database is authoritative, not a JSON
  file on another host. `identity:users_manage` authorizes all administration;
  no new permission, role bypass or employee self-service is introduced.
- A stable unique slug, a versioned draft and a separate published snapshot.
  Save does not publish; publication is a deliberate action of the stored draft.
  A client supplies the expected version; conflicting edits are refused. Mutation
  request IDs are recorded with actor-bound hashes under the user's row lock.
- Slugs cannot change or be reused, including when hidden. Draft and published
  fields are explicit, separate from login identity. No automatic publication of
  the login email, role assignments or account metadata.
- Publication and deactivation serialize on the user row. A database trigger
  clears publication in the deactivation transaction and records an audit event.
  The database refuses publishing an inactive user and refuses cross-user photos.
- Photos are uploaded, not fetched from arbitrary URLs. Only bounded JPEG/PNG
  rasters are decoded, cropped and re-encoded to a fresh 512px PNG. Original bytes,
  file names and EXIF are not persisted. The existing pinned canvas package moves
  from development to runtime dependencies; no new version is selected.
- Immutable private photo objects use FileStorage (`employee-card-photos`). Only
  the current active publication can expose a photograph, by slug and publication
  version. Private previews require administrative access. No public S3 ACLs or
  permanent direct object URLs. Responses are `no-store` and `nosniff` where binary.
- Anonymous DTO is a strict whitelist, without internal user ID, draft, photo ID,
  login email, roles, scopes, audit or sessions. There is no anonymous directory.
  A separate Redis quota limits anonymous reads, failing closed if unavailable.
- The owner requires the existing PHP presentation, not a redesign. Reuse its
  geometry, font sizes, spacing, exact logo and pinned Font Awesome Free 6.4.0
  icons (self-hosted with license, not an external CDN). Check against independent
  historical HTML/CSS on synthetic data, not a snapshot generated from the new UI.
  The current card layout and contact actions remain. vCard is UTF-8/CRLF with
  proper escaping and 75-octet folding, without guessing given/family names.
- Public Next routes live at `/id/[slug]`, `/photo` and `/contact.vcf`; relative
  media/contact links also work behind a root-path rewrite on `id.ayvo.co`.
  The legacy `vcard` query redirects by the validated path slug, not query.slug.
  This does not change routing for bottle passports.

## Rollout boundary

This feature does not change live DNS, Apache, PHP/JSON, proxy allowlists or the
public hostname. Production cutover is a separate approved operation after the
same reviewed application release is tested on DEV. A public ID host must expose
only the card routes, their static assets and required media/contact routes,
never the internal OS, administrative API or the database. Cookie/Auth/header
stripping, exact host/TLS handling and visitor-IP forwarding require integration
with the reviewed production public-edge design. The existing site remains live
until every printed slug and vCard link is checked. Do not import real profiles
or portraits into DEV. See `docs/employee-business-cards.md`.

## Consequences

Account disable is fail-closed for public identity as well as authentication.
Already downloaded contacts/photos cannot be remotely erased. The UI says so.
Historical private photo objects remain immutable, like other FileStorage records;
storage retention/deletion is not silently added. Company-wide design/brand assets
remain code assets, not editable HTML supplied by staff.
