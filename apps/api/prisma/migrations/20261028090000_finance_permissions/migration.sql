-- Finance (doc 039, ADR 0039): only the permission catalogue lives in the core (identity owns
-- it); Finance's own data is in schema "finance" with its own migrations
-- (apps/api/prisma-finance). Additive: two permissions granted to ADMIN.

-- Permissions (doc 039 §5): company-wide, ADMIN only for now (FINANCE stays a planned role).
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:documents_read', 'Finance: received documents — list, detail, history and download of the original', false, false, false, NULL),
  ('finance:documents_manage', 'Finance: receive documents (upload a PDF original or take over a supplier document the user may read), complete or correct their metadata with a reason, void them', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:documents_read'),
  ('ADMIN', 'finance:documents_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
