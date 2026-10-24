# 038 — Native authentication: operation, mail, keys and rollback

Decision: [ADR 0037](adr/0037-native-authentication.md). Scope, boundaries and gates:
[native-authentication-work.md](native-authentication-work.md). Authorization, roles, scopes and
sessions: doc 021 (unchanged).

Status 2026-10-24: in review, not deployed. Nothing here has been run on DEV or PROD yet.

## 1. What a person sees

1. **Activation (once).** The e-mail from AYVO OS contains a one-time link
   (`https://<host>/activate#token=…`). The page reads the token from the fragment, removes it
   from the address bar and sends it only in a POST body. The person chooses a password (at least
   12 characters), scans the QR code with an authenticator app (or types the shown key), enters
   the 6-digit code and saves the ten recovery codes. Only then is the person signed in.
2. **Sign-in.** E-mail + password, then the authenticator code (or one recovery code via
   „Nemám telefon — použít záložní kód“). One factor alone never gives a session.
3. **Forgotten password.** „Zapomenuté heslo“ sends a reset link (the answer is the same for an
   unknown address). New password, then the authenticator code; MFA stays, all existing sessions
   end, the person signs in again.
4. **New phone.** Signed in: Zabezpečení účtu → password + current code (or a recovery code) →
   scan the new QR → confirm a code → new recovery codes; the old authenticator stops working.

Limits: link tokens 256 bit, links valid as issued (invitation: its expiry; reset: 15 min); a
setup stage 15 min, a sign-in challenge 5 min, 5 code attempts each; Redis rate limits per IP and
account fail closed (503). An abandoned activation leaves the invitation used up — the
administrator sends it again (Správa systému → Uživatelé → user → „Poslat pozvánku znovu“); for
the bootstrap administrator, who has no administrator yet, the operator uses §4 with `--resend`.

## 2. Configuration (per environment, never copied between DEV and PROD)

| Key                                 | Value                                                                 |
| ----------------------------------- | --------------------------------------------------------------------- |
| `AUTH_PROVIDER`                     | `local` (set by Compose; `test` only with `APP_ENV=test`)             |
| `AUTH_ENCRYPTION_KEY`               | `openssl rand -hex 32`, generated on that host; refused if not random |
| `AUTH_MAIL_DRIVER`                  | `google-relay` (approved) or `smtp`; `memory` only in automated tests |
| `AUTH_MAIL_FROM`                    | `system@ayvo.co` (approved sender, owner 2026-10-24)                  |
| `AUTH_SMTP_HOST/PORT/USER/PASSWORD` | only with `smtp`; refused with `google-relay`                         |

DEV: `/opt/ayvo/secrets/dev-preview.env`. PROD: `/opt/ayvo/secrets/prod-auth.env` (ayvo:600,
raw `KEY=value`, nothing else). Both preflights (`deploy-dev.sh --check`,
`deploy-prod.sh --check`) apply the same rules as the API and never print a value.

**Key backup — required before an environment's first activation.** The key decrypts every
enrolled authenticator seed, and the sign-in check opens that seed before a recovery code is even
tried. Without the original key nobody with native credentials can sign in, and there is **no
recovery path in the application**: invitations, `identity:activate-bootstrap` and activation all
refuse an account that already has native credentials, and there is deliberately no
administrator MFA reset or credential deletion. Therefore:

- keep a verified copy of each environment's own key outside its server (not in the database
  backup, not in git, never copied to the other environment), and check that it can be read back;
- after a loss, restore exactly that original key into the environment's secret file and restart;
- a separate disaster-recovery procedure for a lost key would be its own security decision for
  the owner — never improvised SQL against `native_credentials`.

## 3. Mail: Google Workspace SMTP relay

Google Admin rule (set by the owner 2026-10-24): `smtp-relay.gmail.com`, only registered users of
AYVO's domains, only from the public IPv4 addresses of DEV (2.29.23.125) and PROD (2.29.17.36),
TLS required, SMTP authentication off. In `google-relay` mode the application:

- connects only to `smtp-relay.gmail.com:587` (fixed in code), requires STARTTLS and verifies the
  certificate and host name (TLS ≥ 1.2);
- binds an IPv4 socket — the allowlist is IPv4 only; without an IPv4 route it fails, it never
  tries IPv6 and never sends without TLS;
- sends no credentials, and is used only when configured explicitly (no fallback from `smtp`).

Delivery is asynchronous (outbox in `native_auth_tokens`, retried with backoff, 5 attempts while
the link is valid). „Accepted by the mail server“ is recorded as `sent_at`; it is **not** proof of
delivery to the mailbox — the recipient confirms that. SMTP errors are logged without details
(they can echo addresses or content).

## 4. First activation of an environment

The bootstrap ADMIN (doc 021 §8) exists already on DEV and PROD. After the release with native
authentication runs and mail is configured:

- DEV: `docker exec ayvo-dev-preview-api-1 node dist/identity/native-invite-bootstrap.js --email <bootstrap e-mail> [--resend]`
- PROD: `sudo scripts/deploy-prod.sh --activate-bootstrap --email <bootstrap e-mail> [--resend]`

The command refuses every other address, an inactive user, a user without an active ADMIN grant
and an already activated user; it creates no user, changes no role, resets no MFA and never
prints a link. It reports the real state:

| Exit | Meaning                                                                                                                            | Next                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 0    | accepted by the mail server now (not yet proof of delivery to the mailbox)                                                         | the person opens the e-mail             |
| 0    | nothing sent: an earlier link was accepted and is still unused and valid                                                           | wait, or `--resend` if it never arrived |
| 1    | refused (message says why), or queued and not accepted yet (the running API retries)                                               | fix mail / input                        |
| 2    | the link was already opened and the setup not finished (abandoned, expired stage, lost browser), or all 5 delivery attempts failed | `--resend`                              |

`--resend` sends a NEW link by e-mail through the ordinary invitation resend: the token is
rotated, so the old link and any setup started with it stop working; the person starts the
activation again (password, new authenticator). A plain repeat without `--resend` never changes
anything. The administrator then invites everyone else through the normal user administration.
Existing users activate natively once; nothing is exported from WorkOS.

## 5. Order of switching

0. Each environment's `AUTH_ENCRYPTION_KEY` backed up off the server and read back (§2).
1. Review + green CI on the exact head; standard DEV deployment with backup (owner approval).
2. Owner on DEV: activation, sign-in, sign-out, recovery code, password reset.
3. The same commit on PROD (own key, own mail sender check), then §4 on PROD.
4. Only after PROD acceptance: remove WorkOS secrets/configuration (do not revoke earlier).

**Sessions during the switch.** Deploying native authentication does not end existing AYVO
sessions: a session created earlier through WorkOS stays valid until its idle (120 min) or
absolute (12 h) limit, or until the user is deactivated; a native activation ends only the
activating user's own sessions. Nobody can start a new WorkOS sign-in after the switch. This is
intended (no forced sign-out); deactivate a user to end their access at once.

## 6. Rollback (application only — never a database restore)

The migration `20261027090000_native_authentication` is additive: new tables and `LOCAL` allowed
in two provider checks. Rolling back = starting the previous release (`deploy-prod.sh --rollback
<release>`; DEV: deploy the previous commit). The previous release ignores the new tables, so
native credentials survive and work again when native authentication is redeployed.

Before rolling back, know that the previous release:

- needs its WorkOS configuration again (that is why it is removed only after acceptance);
- treats a `LOCAL` identity as "signs in already" in the user list, and cannot resend or revoke a
  `LOCAL` invitation through WorkOS (the action fails) — revoke open native invitations
  first if they matter;
- accepts sessions created by native sign-in until they expire (the session table is shared).

Never wipe or restore the database to change authentication: that loses business data created in
the meantime (doc 035 restores are for disasters only).
