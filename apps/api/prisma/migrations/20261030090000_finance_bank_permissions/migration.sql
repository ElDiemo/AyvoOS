-- Finance — bank transactions read from Raiffeisenbank Premium API (N3B-1, doc 041; ADR 0039):
-- only the permissions live in the core catalogue; the transactions and synchronisation runs are
-- in schema "finance" (apps/api/prisma-finance). Read only: nothing is ever sent to the bank.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:bank_read', 'Finance: see the company bank account transactions read from the bank and the state of the bank connection (never its secrets)', false, false, false, NULL),
  ('finance:bank_sync', 'Finance: start reading new transactions from the bank (read only; no payment is ever sent); needs finance:bank_read to see them', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:bank_read'),
  ('ADMIN', 'finance:bank_sync');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
