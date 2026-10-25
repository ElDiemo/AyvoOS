-- Finance — export for the accountant (doc 039 §7, N2; ADR 0039): only the permission lives in the
-- core catalogue; the exports themselves are in schema "finance" (apps/api/prisma-finance).
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:exports_manage', 'Finance: create the monthly export for the accountant (ZIP with a CSV manifest and the originals) and record its handover; history and downloads need finance:documents_read', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:exports_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
