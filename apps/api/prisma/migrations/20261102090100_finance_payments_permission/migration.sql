-- Finance — incoming payments (N3B-2, doc 041 §8; ADR 0039): only the permission lives in the core
-- catalogue. Recording payments from bank transactions already read, simulating a statement
-- outside production and allocating a payment by hand (with a reason). Never a payment order or
-- any other bank action. ADMIN only; reading needs finance:invoices_read.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:payments_manage', 'Finance: record incoming payments (from read bank transactions, or a simulated statement outside production) and allocate them to invoices with a reason', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:payments_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
