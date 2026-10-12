-- Identity and access refinements (doc 021, owner review of PR #6). Additive only: new
-- permissions and role grants are INSERTed; no row is deleted and no permission is removed.
--
-- * ADMIN sees and manages the whole system — through ordinary role_permissions rows, never a
--   code bypass. Every permission a future migration adds must be reviewed and granted to ADMIN
--   explicitly (test/identity.e2e.test.ts fails while ADMIN lacks a catalogue permission).
-- * Purchase prices and supplier documents get their own permissions; inventory:read no longer
--   implies them (the API omits them from responses).
-- * SALES reads a planning-only stock summary.

INSERT INTO "permissions" ("code", "description", "warehouse_scoped") VALUES
  ('inventory:stock_summary', 'Read stock availability for planning: item, available, reserved, low stock', true),
  ('procurement:cost_read', 'Read purchase prices, currencies and VAT rates of goods receipts', false),
  ('procurement:documents_read', 'Read supplier documents (invoices, delivery notes) and their files', false);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'inventory:read'),
  ('ADMIN', 'inventory:stock_summary'),
  ('ADMIN', 'inventory:receive'),
  ('ADMIN', 'inventory:correct'),
  ('ADMIN', 'inventory:items_manage'),
  ('ADMIN', 'procurement:suppliers_manage'),
  ('ADMIN', 'procurement:cost_read'),
  ('ADMIN', 'procurement:documents_read'),
  ('ADMIN', 'production:read'),
  ('ADMIN', 'production:bottles_create'),
  ('ADMIN', 'production:labels_print'),
  ('ADMIN', 'production:templates_manage'),
  ('ADMIN', 'production:label_apply'),
  ('WAREHOUSE_SUPERVISOR', 'procurement:documents_read'),
  ('FINANCE', 'inventory:read'),
  ('FINANCE', 'procurement:cost_read'),
  ('FINANCE', 'procurement:documents_read'),
  ('SALES', 'inventory:stock_summary');

-- Role descriptions are documentation only; the catalogue is otherwise immutable. The trigger is
-- re-enabled in the same migration.
ALTER TABLE "roles" DISABLE TRIGGER "roles_immutable";
UPDATE "roles" SET "description" = 'Sees and manages the whole system: every permission, granted explicitly'
  WHERE "code" = 'ADMIN';
UPDATE "roles" SET "description" = 'Stock availability for planning (read-only summary)'
  WHERE "code" = 'SALES';
UPDATE "roles" SET "description" = 'Reads stock and goods receipts including purchase prices and supplier documents'
  WHERE "code" = 'FINANCE';
UPDATE "roles" SET "description" = 'Receipts, corrections, item planning settings, suppliers, supplier documents (no prices)'
  WHERE "code" = 'WAREHOUSE_SUPERVISOR';
ALTER TABLE "roles" ENABLE TRIGGER "roles_immutable";
