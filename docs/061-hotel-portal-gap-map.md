# 061 — Hotel portal: what exists, what is in a PR, what waits for the owner

Status: **working map, updated 2026-11-10** (main `1c1b995`). Against issue #169 (AYVO HOTEL v1). Sources: issue #125 (owner priority), ADR
0045 §9 (PR #127), doc 040 §14, doc 053. It decides nothing; it shows the gaps so the owner can pick
the next steps. Update it when a PR merges.

## 1. Done on main

| Area          | What                                                                             | Where               |
| ------------- | -------------------------------------------------------------------------------- | ------------------- |
| Own runtime   | portal-web (BFF), its own token, reserved DB pool, budgets, fail closed          | ADR 0045 §1, §6, §8 |
| Accounts      | PORTAL audience in the DB; staff and portal accounts never mix                   | #136                |
| Grants        | per payer and hotels, issued via Finance, revocation                             | #137, #139          |
| Sign-in       | invitation, activation (password + TOTP), sign-in, reset, recovery codes, logout | #138, #143          |
| Moje hotely   | own hotels, read only                                                            | #143                |
| Profil hotelu | address, main contact, receiving contact, delivery note, with a reason           | #145, doc 053       |
| Faktury       | own invoices, payment state, PDF (one Finance predicate)                         | #140, #143          |
| Edge          | dev-portal host, path allowlist, body limits                                     | #146, doc 052       |

## 2. In open PRs (not merged, not deployed)

| PR                 | What                                                                                     | #169           | State                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------- | --------------------------------------------- |
| #148               | Signed contracts, read only                                                              | P0 5           | CI green; waits for review                    |
| #149               | Deliveries (planned / on the way / delivered), nearest delivery, 60-day plan days        | P0 2, 3, 4     | stacked on #148; review P2×2 fixed at 0d782dc |
| #170               | "Moje hotely" dispatch at a glance; hotel switcher; isolation test across several hotels | P0 1, 2        | stacked on #149 (merged in 0d782dc)           |
| #150               | Invoice package for a period (ZIP)                                                       | P0 6 follow-up | after the deliveries                          |
| #147               | Hotely → Uživatelé (staff manage portal accounts)                                        | —              | draft                                         |
| #151               | Change history on the staff hotel detail                                                 | —              | draft                                         |
| #161 → #163 → #165 | Zabezpečení účtu: new phone, sign out everywhere, change password                        | —              | #161 CI green                                 |

Done = merged **and** on DEV **and** confirmed by the owner (#169). Nothing above is done yet.

## 3. Gaps that need no new business rule (candidates)

- **Sign out of all devices** (lost phone): the core already revokes all sessions of an account.
- **My access**: which payer and hotels the account may see, and the session's expiry (the session
  view already carries the grants).
- **Invoice filters**: by hotel and payment state (the Finance predicate stays the only filter).
- **Password change while signed in**: today only through "Zapomenuté heslo" (e-mail link). A
  direct change needs a new core step (current password + code); the staff app has none either.

## 4. Gaps that wait for the owner (not started)

- **Orders from the hotel** (extra delivery, a change of the supply plan) — ADR 0045 §9 "not in the
  portal at all for now".
- **Returns / pickup requests** — the bottle cycle (doc 047/048) has no hotel-side request yet.
- **ESG / bottle statistics** — no CO2e claims without a methodology (CLAUDE.md).
- **Hotel groups** (one account across a chain's payers) — ADR 0045 §9.
- **Overdue wording** on invoices — doc 040 §14.5.
- **Languages** other than Czech — ADR 0045 open question.
- **Hotel users inviting colleagues** — today only AYVO invites (grants are AYVO's decision).
- **Notifications** (e-mail on a new invoice or a delivery) — no automatic sending exists.
- **Support / contact page** — needs AYVO's contact details and wording.
