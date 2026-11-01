-- How a delivery was asked to be sent, fixed with its request (the update trigger allows no change):
-- SIMULATION leaves the system with nothing, RELAY goes through the real relay. A sending never
-- happens in another mode, and what an attempt's result means never depends on today's configuration.
-- No default: this PR's table has no rows anywhere, and a row without a known mode must not be guessed.
ALTER TABLE "finance"."invoice_deliveries"
  ADD COLUMN "mode" text NOT NULL CHECK ("mode" IN ('SIMULATION', 'RELAY'));
