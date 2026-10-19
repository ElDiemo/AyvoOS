# ADR 0027: Carrier credentials entered in the administration, encrypted in the database

- **Status:** Accepted — requested by the owner 2026-10-19 (PR #37)
- **Date:** 2026-10-19
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** extends doc 029 §9 (credentials only in the server env file).

## Context

The owner wants to enter and replace carrier credentials (PPL CPL: client id + client secret)
in the administration, not over SSH. Requirements: ADMIN only; the secret hidden while typed and
never returned to a browser after saving (replace only); no plaintext secret in the database; the
change audited without any secret value; DEV strictly the carrier's TEST environment; replacing
the credentials must never redirect the verification, polling or cancellation of shipments
already created to another carrier account. PostgreSQL is the source of truth (ADR 0002); there
is no external secret manager in this stage.

## Decision

1. **Table `carrier_connections`** — one row per server-side connection code (only `PPL_TEST` is
   defined in code). It holds the client id, an account fingerprint, and the secret **only as
   AES-256-GCM ciphertext** (random 12-byte IV, 16-byte tag), bound as additional authenticated data
   to the connection code and client id. Rows are replaced, never deleted. The database allows only
   `environment = 'TEST'`; a production connection needs its own approved migration.
2. **The key** (`CARRIER_CREDENTIALS_KEY`, 32 random bytes, base64) exists only in the server
   environment file (`/opt/ayvo/secrets/…`, outside git), never in the database. A `key_id`
   fingerprint is stored so a secret is read only with its own key. Without the key nothing can be
   entered; stored credentials that cannot be read (another key) are shown as unreadable and are
   **never** replaced silently by another source.
3. **Precedence:** credentials entered in the administration; otherwise the server env file
   (`PPL_TEST_CLIENT_ID/SECRET`). The UI shows only "nastaveno / nenastaveno" and the source.
4. **Write-only API:** `POST /api/admin/carrier-connections/:code/credentials`
   (`carriers:connections_manage`, security administration — ADMIN only, never a custom role).
   The response, audit (`CARRIER_CREDENTIALS_REPLACED`: connection, environment, whether the
   account changed) and the idempotency record (keyed HMAC digests only) contain no secret.
5. **Account binding:** every shipment and carrier request records `carrier_account` (a SHA-256
   fingerprint of the client id). Polling, label download and cancellation of an existing request
   use the connection only if its current account is the same; otherwise the shipment shows "the
   connection is not available". A site's "Ověřit připojení" records the account too; another
   account requires a new verification before new shipments.
6. The API base URL stays fixed in code per connection and is not part of any contract.

## Consequences

- Credentials can be managed without SSH; secrets at rest are protected by a key outside the
  database. Anyone with both the database and the server env file can decrypt — the same trust
  boundary as the env file today.
- Losing or rotating the key makes stored credentials unreadable until they are entered again
  (visible in the UI; no fallback).
- Replacing the credentials with another account leaves open shipments of the previous account
  for a person (switch back, or resolve with the carrier) — by design, never redirected.
- A dedicated secret manager (KMS/Vault) can later replace the env key without changing the API.
