# Hotely → Uživatelé: hotel portal accounts apart from internal users

Owner, 2026-11-09: hotel accounts do not belong among the internal users. They get their own staff
tab under Hotely.

## The boundary

- **Internal users (Správa systému → Uživatelé)** are only `STAFF` accounts. The list, the detail
  and every mutation of `UsersService` (access, roles, site and warehouse scopes, invitations,
  deactivation, reactivation) filter by the account's audience on the server. A `PORTAL` id
  answers `404 USER_NOT_FOUND`, the same as a missing one. Business cards
  (`EmployeeCardsService`) are staff only as well. The earlier guards (`ROLE_AUDIENCE_MISMATCH`,
  `ACCOUNT_AUDIENCE_MISMATCH`) remain behind it.
- **Hotely → Uživatelé** (`/hotels/users`, API `/api/admin/identity/portal-accounts`) lists only
  `PORTAL` accounts with all their grants (active first), their hotels, invitation state, last
  sign-in and open sessions. An internal id answers 404 there.

## Permissions (unchanged catalogue)

| Action                                      | Permission                                                |
| ------------------------------------------- | --------------------------------------------------------- |
| List and detail of portal accounts          | `identity:portal_grants_manage`                           |
| Deactivate or reactivate a portal account   | `identity:portal_grants_manage` + `identity:users_manage` |
| Revoke a grant (existing core route)        | `identity:portal_grants_manage`                           |
| Issue, replace, invite (Finance payer page) | `finance:billing_read` + `identity:portal_grants_manage`  |

No permission or role was added or granted. Two things change in practice:

- An account with only `identity:users_read` no longer sees portal accounts.
- Changing a portal account's state now also needs the grant permission.

Today all of these permissions belong to ADMIN only.

## What is reused

- **Deactivation and reactivation** share the internal account's code path (`UsersService`): the
  account's row lock, `CANNOT_DEACTIVATE_SELF`, `ALREADY_*`, revoking all sessions in the same
  transaction, and the audit types `USER_DEACTIVATED` / `USER_REACTIVATED` with a reason. The
  last-admin check applies only to staff.
- **Grants** are revoked by the existing `POST /api/admin/identity/portal-grants/:id/revoke`.
  Issuing, replacing and inviting stay on Finance's payer page (its check of payer and hotels).
  The tab links there, and shows the payer's name when the viewer may read billing.
- Sign-in, sessions, roles and the audit path are unchanged.

## Hotel card → Přístup do portálu (owner, 2026-11-10)

- The hotel's card (`/hotels/<code>#pristup-do-portalu`) shows the portal accounts assigned to
  that hotel by an **active** grant: name (link to the account in Hotely → Uživatelé), e-mail,
  account and invitation state, when it was assigned and by which payer. It is filtered on the
  server (`GET /api/admin/identity/portal-accounts?hotelId=<uuid>`: only those accounts, each with
  only the active grants naming the hotel); the card never receives the list of all accounts.
- Same permission as the tab (`identity:portal_grants_manage`); without it the section, the list
  and the e-mails are absent (API 403). Payer names and links only with `finance:billing_read`.
- Inviting an account or changing an assignment links to the hotel's current payer page
  (Finance → Plátci → plátce → Přístup do portálu): the one existing write path with Finance's
  check before the core. No new write route.
- The account's detail links each assigned hotel to that section and offers "Spravovat přístup u
  plátce" per grant (the payer's page), beside the existing revocation.

**Dependency.** A grant hotel is shown as an _assignment_ only. Whether it is operational access
or invoices only is not recorded yet: the boundary is the open proposal on #148 (review
5841786998, comment 6767450591) awaiting the owner. Until then the UI makes no claim about
operational rights; once approved, the card shows the kind of access per hotel.
