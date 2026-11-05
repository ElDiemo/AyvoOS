# 046 — QR presentations (demo pages for the presentation package)

Status: **proposal for review** (owner request 2026-11-05, ADR 0044). The model and the published
scope wait for the review before any database implementation. The UI is prepared meanwhile in a
branch, with synthetic data only.

## 1. Goal and limits

- Two presentation bottles for a presentation package: **liquid soap 330 ml** and **Mixt gel
  330 ml (body and hair)**. Each gets a QR that opens a well-made mobile page.
- An ADMIN reaches both demos easily in the existing internal app (Správa systému): open the
  public page, preview and download the QR.
- Not in scope:
  - real bottles;
  - stock movements, reuse cycles or production records;
  - a CMS, a marketing runtime or a new vendor;
  - opening any public path;
  - printed QR codes (none exist yet, owner 2026-11-05).

## 2. Current state (verified 2026-11-05)

| Item         | State                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passport API | `GET /api/public/bottles/:token`, `@Public()`, rate limit per IP in Redis (fail closed), `Cache-Control: public, max-age=60`                                                                             |
| Passport DTO | `publicBottlePassportSchema` = `{ bottleCode, reuseCycles }` only                                                                                                                                        |
| Page         | `/q/[token]`: English, looks up bottle → crate → workstation; unknown = "Not found"                                                                                                                      |
| QR registry  | `qr_identities` (`BOTTLE`/`CRATE`/`WORKSTATION`), immutable, filled by DB triggers                                                                                                                       |
| Token        | `generatePublicToken()` = 16 random bytes, base64url (ADR 0014)                                                                                                                                          |
| QR rendering | `qrcode` 1.5.4 (`apps/web/src/components/qr-code.tsx`, SVG)                                                                                                                                              |
| PROD edge    | `Caddyfile.qr`: only `GET`/`HEAD /<22 chars>` → `web` `/q/<token>`, static assets, else 404. Verified read-only by the owner 2026-11-05 (HTTPS valid, unknown token 404, `/login` 404). PROD = `b060802` |
| DEV          | `/q/<token>` reachable only inside the tailnet (ADR 0026)                                                                                                                                                |

**Stale statuses.** The documents lag behind reality:

- doc 011 says "Draft — foundation phase";
- doc 037 says "prepared, not installed";
- ADR 0035 says "Proposed".

The edge is running on PROD. This PR proposes no wording for them; the owner or Codex confirms
the installed state, and the statuses are then updated in a separate commit.

## 3. Data (ADR 0044 §1–3)

```
qr_identities.kind  += 'PRESENTATION'

qr_presentations
  id            uuid PK
  profile       enum PresentationProfile (HAND_SOAP_330 | MIXT_GEL_330)
  qr_token      text  ┐ FK (qr_token, qr_kind) → qr_identities(token, kind)
  qr_kind       'PRESENTATION' (CHECK)
  created_at    timestamptz
  created_by_id uuid → users
  UNIQUE (profile)        -- one identity per profile and environment
  UNIQUE (qr_token)
```

- The token is registered in `qr_identities` by an insert trigger, like crates. It is immutable:
  updates are refused for `qr_token` and `profile`, and deletes are refused.
- There is no content in the database. The profile texts are in code (`presentation-profiles.ts`,
  frozen by an inline snapshot test, like `cs-b2b-1`).
- Nothing touches bottles, inventory, crates or production.

## 4. Public DTO and page

```ts
publicPresentationSchema = z.strictObject({
  kind: z.literal('PRESENTATION'),
  profile: z.enum(['HAND_SOAP_330', 'MIXT_GEL_330']),
  demo: z.literal(true),
});
```

- The route is `GET /api/public/presentations/:token`. It has the same guard, rate limit and
  cache header as the bottle passport. An unknown token answers 404.
- The page `/q/<token>` adds a fourth lookup and renders the profile from code:
  - a "DEMO" band at the top;
  - the product name, "330 ml", and the general use ("for hands" / "for body and hair");
  - the line "Presentation sample — not a registered bottle";
  - a short "What is AYVO" line taken from the existing passport copy.
- The page never shows a bottle code, a reuse count, sustainability figures or composition.
- The page is mobile first (320–430 px) and keeps working at 1440 px.

Profile texts (proposed, from documented facts only):

| Profile         | Name        | Volume | Use               |
| --------------- | ----------- | ------ | ----------------- |
| `HAND_SOAP_330` | Liquid soap | 330 ml | For hands         |
| `MIXT_GEL_330`  | Mixt gel    | 330 ml | For body and hair |

## 5. Management (internal app)

- The page is Správa systému → "QR ukázky" (`/admin/qr-presentations`). Permission
  `qr:presentations_manage` is added to the catalogue and granted to ADMIN in the same migration.
- Each profile has a card:
  - Without a QR: the button "Vytvořit QR ukázky" with a confirmation. The server creates the
    identity once. A second request answers 409, and a replay with the same `requestId` answers
    the same.
  - With a QR:
    - "Otevřít ukázku" opens the public URL in a new tab;
    - the QR preview (SVG);
    - "Stáhnout QR (SVG)";
    - the encoded URL as text.
    - On DEV the preview and the download carry `DEV - NOT FOR PRODUCTION`.
- Creating writes an audit event. Opening or downloading writes nothing.

## 6. DEV and PROD

- The same code everywhere, with no environment branch beyond `PUBLIC_QR_BASE_URL` and the
  existing QR policy.
- DEV: an ADMIN creates both identities on DEV. They answer only inside the tailnet.
- PROD: nothing until an approved release. Then an ADMIN creates both identities on PROD. The
  tokens differ from DEV because they are generated per environment and never copied.
- No change to Caddy, DNS, the host guard or `qr-edge`.

## 7. Tests and acceptance

- **API, real DB:**
  - create once (a second request is 409, a replay is idempotent);
  - the token is in `qr_identities` with kind `PRESENTATION`;
  - an update or delete is refused by the DB;
  - the public DTO is strict;
  - an unknown token or a bottle token answers 404 on the presentations route, and a presentation
    token answers 404 on the bottles route;
  - without the permission the API answers 403;
  - no rows appear in `bottles`, `bottle_events` or `inventory_movements`;
  - the route declaration test passes.
- **Playwright:**
  - ADMIN creates both;
  - opens the public page at 390 px and 1440 px with the DEMO marking, product, 330 ml and use;
  - the QR SVG decodes to the shown URL (`jsqr`);
  - a user without the permission sees no menu entry and gets 403.
- **Accepted when:**
  - on DEV, both QR codes scanned by a phone on the tailnet open the demo page;
  - Codex has reviewed the change;
  - the owner has approved the texts.

## 8. Open for the owner

1. The page language. The public passport is English today (CLAUDE.md). Should the demo be
   English, Czech, or switchable?
2. The exact product names on the page: "Liquid soap" / "Mixt gel", or the Czech "Tekuté mýdlo" /
   "Mixt gel (tělo a vlasy)".
3. Whether the PROD QR codes may be created right after the release, or only for a printing date.
