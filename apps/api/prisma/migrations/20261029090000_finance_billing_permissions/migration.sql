-- Finance — hotel billing settings (doc 040, N3A-1; ADR 0039): only the permissions live in the
-- core catalogue; customers, hotel billing agreements and the default price list are in schema
-- "finance" (apps/api/prisma-finance). Additive: two permissions granted to ADMIN.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:billing_read', 'Finance: hotel billing settings — customers, hotel billing agreements with their versions, the default price list and the terms effective for a month', false, false, false, NULL),
  ('finance:billing_manage', 'Finance: create and version customers, hotel billing agreements (billed rooms, own price, currency, payment terms) and the default price list, with a reason', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:billing_read'),
  ('ADMIN', 'finance:billing_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
