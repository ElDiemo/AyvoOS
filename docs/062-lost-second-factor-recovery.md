# 062 — Lost phone and recovery codes: restoring access (proposal)

Status: **proposal for the owner, nothing implemented.** Today an account (staff or hotel portal)
that has lost both its authenticator app and every recovery code has no way back: there is no
admin action, and native credentials can never be deleted (DB trigger
`native_credentials_transition`, doc 038). Only creating a new user would help, which loses the
account's history and grants.

## Proposal: "Obnovit přístup" by an administrator, then an e-mailed link

1. An administrator (`identity:users_manage` for staff; the grant administrators' permission for
   portal accounts, #147) verifies the person **outside the application** (e.g. a phone call to a
   known number) and clicks "Obnovit přístup" with a **required reason**.
2. In one transaction: every session of the account ends, pending sign-ins stop, and a one-time
   link with a new purpose `REENROLL_MFA` is written (e-mailed through the existing outbox; the
   same lifetime as a reset link). Audit `MFA_RESET_ISSUED` with the actor and the reason.
3. The person opens the link, enters their **current password** and enrols a new authenticator.
   The credential is updated, never deleted (`totp_ciphertext` + `revision`/`mfa_revision`, as the
   trigger already allows); new recovery codes; audit `MFA_RESET_COMPLETED`.
4. A forgotten password as well: the existing reset link after that (two steps, on purpose).

## What it needs (model change, for approval)

- A migration: the token purpose and the challenge kind `REENROLL_MFA` (enum values).
- `NativeAuthService`: issue (admin) and complete (link + password + new TOTP), reusing the
  enrolment code paths; rate limits as for reset.
- Staff UI on the user detail; the portal account detail in Hotely → Uživatelé (#147).
- Tests: wrong password at the link, an expired or reused link, an admin without permission, a
  deactivated account, sessions ended, a staff link never usable in the portal (audience).

## Risks and the questions for the owner

- Whoever controls the person's e-mail **and** knows the password could enrol after an admin
  issued the link. The out-of-band check in step 1 is the defence. **Who may do the check, and
  how?**
- Should the administrator be someone other than the person (no self-reset)? Proposed: yes.
- Should the hotel's own manager be able to ask for it in the portal? Proposed: no, AYVO only.
