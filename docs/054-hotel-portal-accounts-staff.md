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
