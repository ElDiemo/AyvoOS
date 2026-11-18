-- Sales commissions PR 2a — the permission of the Finance commission closing (doc 069 §4, O8;
-- owner approved doc 069 §3–§6 and O1–O16 for the first DEV version on 2026-11-18).
--
-- `finance:commissions_manage`: preview and approve the monthly commission statements in
-- Obchod → Provize, and the core contract Finance reads for it (who gets the commission for a
-- hotel and month, with the bound rates). ADMIN only, never a custom role: `security_admin`
-- makes role_permissions_guard refuse it outside the system ADMIN role (as for
-- sales:commission_terms_manage). Catalogue only — no table, trigger or other change.
--
-- Atomic: BEGIN … COMMIT, so a failure never leaves the permission without its ADMIN grant.

BEGIN;

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:commissions_manage', 'Finance: preview and approve the monthly commission statements of salespeople and read the attribution contract for it', false, true, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:commissions_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);

COMMIT;
