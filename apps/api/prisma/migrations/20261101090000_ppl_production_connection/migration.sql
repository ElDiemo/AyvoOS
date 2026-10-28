-- PPL production connection (ADR 0042, doc 029 §9b; owner 2026-10-27).
-- The code (fixed server-side in apps/api/src/carriers/ppl/ppl-connections.ts) and its environment
-- belong together: PPL_TEST is always TEST, PPL_PRODUCTION always PRODUCTION — a stored row can
-- never claim another environment than its connection. Each connection keeps its own row (own
-- credentials, encrypted with the code as associated data); the existing PPL_TEST row is unchanged.
-- No other table changes: a site's settings already name a connection, and requests and shipments
-- already record their own connection, environment and account.
ALTER TABLE "carrier_connections" DROP CONSTRAINT "carrier_connections_environment_check";
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_environment_check" CHECK (
  ("code" = 'PPL_TEST' AND "environment" = 'TEST')
  OR ("code" = 'PPL_PRODUCTION' AND "environment" = 'PRODUCTION'));
