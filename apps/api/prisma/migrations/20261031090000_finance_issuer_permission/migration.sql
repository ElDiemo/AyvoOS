-- Finance — our company (the issuer of invoices) and its bank accounts (N3A-2a, doc 040 §8;
-- ADR 0039): only the permission lives in the core catalogue; the settings are in schema
-- "finance". Reading and changing them is one permission: no other role sees this configuration.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:issuer_manage', 'Finance: read and change our company''s invoicing details (issuer) and the bank accounts shown on invoices, with history; never the bank connection''s secrets', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:issuer_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
