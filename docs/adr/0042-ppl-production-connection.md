# ADR 0042: PPL production connection, chosen explicitly per site

- **Status:** Proposed — for review. Requested by the owner on 2026-10-27 (PROD shows only
  "PPL_TEST" in Dopravci; the owner holds production PPL credentials). Extends ADR 0027 and doc 029
  §9; nothing of them is replaced.
- **Date:** 2026-10-27
- **Context:** `PPL_CONNECTIONS` in code contained only `PPL_TEST`, and `carrier_connections`
  allowed only `environment = 'TEST'` ("a production connection needs its own approved
  migration"). The rest of the design already separates connections: credentials per connection
  row (AES-256-GCM, the connection code as associated data), a site's settings name one
  connection, a verification counts only for that connection and account, and every request and
  shipment records its own connection, environment and account — later requests never take over
  earlier ones.

## Decision

1. **A second fixed connection `PPL_PRODUCTION`** → `https://api.dhl.com/ecs/ppl/myapi2`, beside
   `PPL_TEST` → `https://api-dev.dhl.com/ecs/ppl/myapi2` (PPL CPL API, "Obecné", verified
   2026-10-27). URLs are in code only; no user edits them.
2. **Production only in production:** `PPL_PRODUCTION` exists with `APP_ENV=production` (and in
   automated tests, against the simulated PPL server). On DEV it is not listed, its credentials
   cannot be stored, a site cannot choose it and no gateway is built for it. The same application
   runs on DEV and PROD; only `APP_ENV` differs.
3. **Own credentials, entered by the owner:** production credentials only through Správa systému →
   Dopravci (encrypted, write-only, audited without values) — never a server env file, never DEV.
   The test connection keeps its optional server env file.
4. **Explicit choice per site:** switching a site's settings to a PRODUCTION connection requires
   `confirmProduction: true` (a checkbox in the UI), otherwise `422
PRODUCTION_CONFIRMATION_REQUIRED`. The audit records from → to, the environment and the
   confirmation. As before, a changed connection needs a new "Ověřit připojení" (token + product
   list, read-only) before any new shipment.
5. **No automatic change, no fallback:** the existing `PPL_TEST` row and site settings are not
   touched; a site switched to production makes only its **new** requests production ones;
   existing requests and shipments keep their recorded test connection, environment and account
   (and are refused rather than served by another connection). Nothing creates, orders, prints or
   cancels anything because of this change.
6. **DB:** `carrier_connections_environment_check` ties each code to its environment
   (`PPL_TEST`/`TEST`, `PPL_PRODUCTION`/`PRODUCTION`).

## Consequences

- PROD gains the connection after review, CI, DEV acceptance and the owner's approval; the owner
  then enters the production credentials and runs "Ověřit připojení" (authentication and the
  product list only). The first real shipment is a separate, explicit act of the owner.
- HTTP headers: PPL announced (2026-02-09) that all response headers are lower-case
  (`location`). The adapter reads them through the Fetch `Headers` API, which is
  case-insensitive; a test pins this.
- Other carriers are out of scope.
