# Employee business cards — implementation and cutover checklist

Status: local implementation, not merged or deployed. ADR 0036. Owner request and
administrator/deactivation rules confirmed on 2026-10-23.

## User journey

Správa systému → Uživatelé → employee → **Veřejná vizitka** → Otevřít nastavení.
Enter a stable slug and explicit public data (name, role, optional company,
tagline, phone, email, website, LinkedIn). Public email starts blank. Upload a
JPEG/PNG photograph (without a photograph the avatar is omitted, as on the existing site). The preview has the same
layout as the public card but inert contact buttons, so previewing never dials,
emails or downloads a misleading contact.

`Uložit koncept` saves only the draft. `Zveřejnit uložený koncept` requires a
saved version and an active employee; it warns that the data will be public.
`Skrýt vizitku` revokes the page, vCard and photo routes, without discarding
unsaved editor text. A concurrent edit is 409; reload updates the server version
but preserves entered fields for review. Mutations require a reason and audit.
Deactivation hides in the database transaction; reactivation requires a new
explicit publication. No editing/publishing by SALES or other ordinary users.
After publication, **Otevřít zveřejněnou vizitku** opens `/id/<slug>` in a new
tab in the current environment. It never jumps from DEV to the still-existing
production PHP site. A hidden/unknown card shows a plain unavailable page,
without a link into the internal OS.

Owner clarification 2026-10-23: the first live preview may use the normal
VPN-protected DEV address. Do not create an `id-dev` domain, open DEV ports or
change DNS for this preview. The final production ID host must be anonymous and
reachable without VPN; that is still the separate cutover below.

Owner clarification, appearance: this is not a redesign. Reuse the original PHP
card's presentation: 420px card, 26px corners, 96px photograph, original system
font stack, padding, text sizes/line heights, contact-button spacing/hover,
Font Awesome Free 6.4.0 icons and exact existing footer logo. The company field
is retained in the downloaded contact; the old PHP does not render a separate
company line and neither does this version. External web/LinkedIn links keep
opening a new tab; phone, email and vCard actions retain their function.

The logo and original icon fonts are self-hosted with source/checksum/license
in `apps/web/public/employee-card/README.md`. The DEV/test notice is intentionally
outside the card, never a production design element. An independent historical
HTML/CSS fixture with synthetic contacts checks the actual public card at 1440,
390 and 320px in the same browser (RGBA tolerance 1/255 only for rounded-edge
compositing). No real person's profile/photo is copied to DEV for comparison.

## API

All admin paths start `/api/admin/identity/users/:userId/business-card`:

- GET — optional card, for `identity:users_manage` only.
- POST — `requestId`, `expectedVersion` (0 on create), `slug`, `fields`, `reason`.
- POST `/publish`, `/hide` — `requestId`, `expectedVersion`, `reason`.
- POST `/photos` — multipart `file` + `requestId`; JPEG/PNG ≤5 MiB and ≤4096×4096.
- GET `/photos/:photoId` — private normalized PNG owned by this user.

Anonymous reads: `/api/public/employee-cards/:slug`, `/contact.vcf`, and
`/photo?version=<publicationVersion>`. No list endpoint. Strict public fields:
slug, version, hasPhoto, name, role, company, tagline, phone, email, website,
LinkedIn. The quota is separate from login, 120 reads per minute per resolved
visitor IP; storage failures return 503. No hidden file or draft lookup by ID.

Frontend routes are `/id/:slug`, `/id/:slug/photo` and `/id/:slug/contact.vcf`.
All personal-data responses are uncached; the photo route rechecks publication
after storage I/O. A newly published photo/version invalidates old photo URLs.
Development/test pages carry an explicit TEST notice. User-admin response schemas,
login, user displayName/email and the role matrix are unchanged.

## Migration and compatibility

The new migration adds only two empty tables, integrity functions/triggers and a
user-deactivation trigger. It inserts no employees, profiles, photos or permissions.
It is not applied to live DEV or PROD as part of development. Old API/UI can still
read users and deactivate accounts; the trigger hides cards even when an old API
performs deactivation. Rolling back the app does not remove the protection or data.
Do not mark a migration rolled back merely because an application rollback occurred.

Photo files use the normal FileStorage boundary and the future production S3
implementation without a separate public bucket. Backups must preserve these
objects as well as DB references; database dumps alone do not contain portraits.
The canvas dependency is the existing pinned `1.0.10`, now a runtime dependency.
Check the normal Linux production image build/optional platform binary in CI.

## Existing public site (do not change yet)

- Host supplied by owner: `65.109.131.247`, Apache `StagingEshop`.
- Document root `/var/www/id.ayvo.co`, active `index.php`.
- Data `/var/data/id_profiles/profiles.json` outside the document root.
- Assets in document root `assets/`, `logo.svg`, favicon; current PHP CSS is inline.
- Existing public route `https://id.ayvo.co/tomas-hanzl` and legacy Save contact
  `?slug=tomas-hanzl&vcard=1`.
- Original PHP/JSON/Apache and all printed cards remain untouched by this change.
  No SSH key, password or employee database is committed or copied to DEV.

## Separate approved production cutover

1. Finish the production launch first; do not interrupt Claude's release work.
2. Review this branch and the migration, run normal CI and browser acceptance on
   the exact head. Reconcile ADR numbering against other pending PRs before merge.
3. Test on DEV using synthetic people only; owner approves the result.
4. Before changing public infrastructure, get an explicit cutover authorization.
   Review how the new ID host composes with the existing private OS/public QR edge.
   Root `/<slug>` must map only to `/id/<slug>`; allow the exact contact/photo
   routes and necessary static assets, including the three pinned visual files
   listed in `apps/web/public/employee-card/README.md`, not an unrestricted application proxy.
5. Explicit host/SNI checks, no session/Auth forwarding from public requests,
   authoritative visitor IP handling and negative tests for internal/admin paths.
   Public read limits must not collapse all visitors to the proxy's address.
6. Securely read/import original approved profiles only on PROD and match each
   employee deliberately. Do not infer login email, create OS users, or publish
   previously private staff automatically. Do not import through DEV.
7. Check all existing slugs, photographs, website/tel/mail/LinkedIn, UTF-8 contact
   downloads, unknown/hidden profiles and IPv4/IPv6/HTTPS before DNS change.
8. Preserve the original site/data as a recoverable rollback copy. DNS can remain
   old during preparation; do not delete PHP/JSON or print new business cards.
9. Any JSON-to-DB import must be explicit, idempotent, auditable and transactional;
   no automatic live scraping or ongoing two-way synchronization is implemented.

No analytics, cookies, staff self-service, profile directory, HR data or new
business role is part of this feature.
