-- Finance — sending an invoice's PDF by e-mail by hand (doc 043, owner 2026-10-30): only the
-- permission lives in the core catalogue; deliveries are in schema "finance". ADMIN only.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:invoices_send', 'Finance: send an invoice''s PDF by e-mail by hand and retry a failed or uncertain sending', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:invoices_send');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
