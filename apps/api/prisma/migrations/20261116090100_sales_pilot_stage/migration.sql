-- Obchod: the stage PILOT between Nabídka and Získaný (owner 2026-11-09 night, the recommended
-- variant of doc 060 §B; subject to the owner's PR review). "Odloženo" is not a stage.
ALTER TABLE "sales_prospects" DROP CONSTRAINT "sales_prospects_stage_check";
ALTER TABLE "sales_prospects" ADD CONSTRAINT "sales_prospects_stage_check" CHECK (
  "stage" IN ('NEW', 'CONTACTED', 'NEGOTIATION', 'OFFER', 'PILOT', 'WON', 'LOST'));
