-- Finance — TEST invoices (N3A-2b, doc 040 §9; ADR 0039): only the permissions live in the core
-- catalogue; invoices are in schema "finance". Issuing exists only for TEST invoices outside
-- production (no live issuing). ADMIN only.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:invoices_read', 'Finance: read invoices (with their lines, PDF and payment state)', false, false, false, NULL),
  ('finance:invoices_test', 'Finance: issue and cancel TEST invoices outside production (never a live invoice)', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:invoices_read'),
  ('ADMIN', 'finance:invoices_test');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
