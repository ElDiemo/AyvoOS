# 026 — A2: Workstations and work sessions (proposal, issue #19)

Status: **Approved by the owner (2026-10-14) as the basis for implementing A2** in its own PR,
including its migrations; role matrix doc 025 §13 B4. Receiving by supplier codes, PPL, orders
and returns are not part of A2.

## 1. Purpose

A workstation is a **work mode at a site** (labelling; filling of one product category) with a
printed QR. The operator — already signed in — scans the station QR **once**; the application then
stays in that station's context, shows it permanently and re-validates it on every operation.
A station is never a new site or warehouse; two filling stations of one site are two rows of this
table. The QR identifies the station only: it is **not** a login, not a permission and not a
secret.

## 2. Model (proposed)

| Table                        | Columns and rules                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workstations`               | id, **code** (catalogue code pattern, globally unique), name, **site_id**, **location_id** (a warehouse of that site; DB check), **mode** `LABELING`/`FILLING`, **category_code** (required for `FILLING`, NULL for `LABELING`), status `ACTIVE`/`INACTIVE`, **qr_token** (registry kind `WORKSTATION`), created_at/by, operation id. Identity columns immutable; status changes only with an event.   |
| `workstation_events`         | append-only: `CREATED`, `DEACTIVATED`, `REACTIVATED`, `QR_LABEL_GENERATED`; actor, reason (required for (de)activation), operation id, occurred_at                                                                                                                                                                                                                                                     |
| `workstation_sessions`       | id (UUID, the resume identity), workstation_id, user_id, site_id (= station site), status `ACTIVE`/`RELEASED`/`TAKEN_OVER`/`CLOSED`, opened_at, **lease_expires_at**, last_activity_at, closed_at/by, close_reason. **Partial unique:** one `ACTIVE` session per workstation and one per user. A3/A4 add their context columns (source lot, product, crate cycle, liquid lot) by their own migrations. |
| `workstation_session_events` | append-only: `OPENED`, `RESUMED`, `HEARTBEAT_GAP`, `RELEASED`, `TAKEN_OVER` (reason), `CLOSED`; later `CONTEXT_CHANGED` (A3/A4); actor, operation id                                                                                                                                                                                                                                                   |
| `qr_identities`              | (A1) gains kind `WORKSTATION`                                                                                                                                                                                                                                                                                                                                                                          |

Lease: configuration (default 15 min, doc 020 §6). Expiry is not a status change; it only allows
an authorized takeover. Expiry never touches a crate cycle, lot or bottle.

## 3. Rules checked by the server on every operation

1. Signed-in user with the permission of the station's mode — `LABELING` → `production:label_apply`,
   `FILLING` → `production:fill` — and access to the station's site (doc 022). Scanning a station
   never grants anything.
2. The station exists, is `ACTIVE` and belongs to the session's **active site**; a station of
   another site is refused (`STATION_OF_ANOTHER_SITE`) — the active site is changed explicitly in
   the shell, never by a scan.
3. Every later operation (A3/A4 scans) carries only `{requestId, sessionId, scannedValue}`: the
   session must be `ACTIVE`, owned by the caller; its lease is renewed; mode, category and site come
   from the stored station — never from the request.
4. A second user scanning a station in use gets `STATION_IN_USE` (holder name, last activity). A
   takeover is an explicit operation (`production:session_takeover`, reason), audited; the previous
   session ends `TAKEN_OVER` and its holder sees that on the next request.
5. **Voluntary handover** (owner B4): the holder releases the station ("Předat / Opustit
   pracoviště"); any authorized operator then opens it with a normal scan — no supervisor. The
   crate in progress (A3/A4) belongs to its cycle, not to the session, so it continues unchanged
   under the next session. A **forced takeover** of an occupied station needs
   `production:session_takeover` (supervisor/ADMIN) and a reason.
6. The same user scanning the same station resumes their session (after reload, sign-in, lost
   connection); scanning another station first releases the current one explicitly
   ("Opustit pracoviště") — a station change never silently changes a crate, lot or bottle.

## 4. API contracts (proposal; `@ayvo/types` after approval)

```ts
// Administration (production:workstations_manage; the station belongs to the active site)
GET  /api/admin/workstations                          → Workstation[]
POST /api/admin/workstations                          { requestId, code, name, mode, categoryCode | null, reason }
POST /api/admin/workstations/:code/deactivate         { requestId, reason }
POST /api/admin/workstations/:code/reactivate         { requestId, reason }
GET  /api/admin/workstations/:code/qr-label?widthMm&heightMm   → PDF (code label renderer of A1)

// Station work (mode permission, see §3)
POST /api/admin/station-sessions                      { requestId, scannedValue }   → { session, station, outcome: 'OPENED' | 'RESUMED' }
GET  /api/admin/station-sessions/current              → { session, station } | null
POST /api/admin/station-sessions/:id/heartbeat        → { leaseExpiresAt }
POST /api/admin/station-sessions/:id/release          { requestId }
POST /api/admin/station-sessions/:id/takeover         { requestId, reason }        (production:session_takeover)

type Workstation = {
  code: string; name: string; mode: 'LABELING' | 'FILLING';
  category: { code: string; name: string } | null;
  site: { code: string; name: string }; warehouse: { code: string; name: string };
  status: 'ACTIVE' | 'INACTIVE';
};
```

Refusal codes (Czech text in the UI, never raw server text): `NOT_AYVO_QR`, `WRONG_ENVIRONMENT`,
`NOT_A_STATION` (a bottle or crate QR scanned instead), `UNKNOWN_STATION`, `STATION_INACTIVE`,
`STATION_OF_ANOTHER_SITE`, `MODE_NOT_PERMITTED`, `STATION_IN_USE`, `SESSION_NOT_OWNED`,
`SESSION_CLOSED`, `IDEMPOTENCY_CONFLICT`. The public QR page of a station token shows only
"Interní označení AYVO".

## 5. UI proposal (`Výroba → Pracoviště`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ PLNĚNÍ · Sprchový gel        Plnicí linka 2 (FILL-GEL-2)     Přerov 1 · MAIN │  ← sticky, large,
│ Přihlášen: Jana N.           [Opustit pracoviště]                            │    text + colour + icon
├──────────────────────────────────────────────────────────────────────────────┤
│ Bedna AYV-C-000123   Obsah 40/40   Naplněno 26/40      (A4)                  │  ← both counts, apart
│ Kapalina: LIQ-GEL šarže L-2410 [Změnit šarži]          (A4)                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Naskenujte lahev …                                   ]  ← focus always here│
│ ✔ AYV-B-000812 naplněna (27/40)          ← result: text + sound + colour     │
│ ✖ AYV-B-000377 patří do bedny AYV-C-000119 – vraťte ji, nic se neodepsalo     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Before a station is scanned: one large scan field "Naskenujte QR pracoviště" and the list of
  the user's own interrupted session (Pokračovat).
- After a refusal the field is cleared and keeps focus; a duplicate scan answers "už potvrzeno,
  nic se neodepsalo"; quick series work without dialogs; no per-bottle forms.
- Same layout on a phone (stacked) and with a keyboard-wedge scanner; the server protections are
  identical.
- Stations administration: list per site, create (code, name, mode, category), deactivate /
  reactivate with reason, print the station QR label (size per print as for crates).

## 6. Test scenarios (A2)

- Open by scanning; resume after reload and after a new sign-in; heartbeat renews the lease.
- Second user on a station in use → `STATION_IN_USE`; takeover only with permission + reason;
  the old holder's next request → `SESSION_NOT_OWNED`; audit and events written.
- Expired lease: the owner resumes; another user still needs a takeover.
- Inactive station, unknown token, a bottle/crate QR, another environment's URL, a station of
  another site, a user without the mode's permission → refused, nothing written.
- Modified request (category or site in the body) ignored/refused; the server uses the station.
- One active session per station and per user under concurrency (parallel opens).
- Station change requires release; the old context is untouched.
- Public QR page of a station reveals nothing internal.
- Playwright: scan station, permanent banner (desktop + 390 px), focus after an error, release,
  takeover, synthetic screenshots.

## 7. Depends on

Owner approval of this model and of the role matrix (doc 025 §13 B4). Independent of B1–B3, B5,
B6 (those block A3/A4/W1).
