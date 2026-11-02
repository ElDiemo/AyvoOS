-- Finance — money received before the invoice's issue (owner 2026-11-02, doc 040 §13, doc 041 §8b):
-- a payment booked before the issue date of the invoice its VS names is never silently an ordinary
-- later payment. It is recorded with its own result, not allocated automatically, and is to review.
-- Only widens the CHECK; no row changes.

ALTER TABLE "finance"."incoming_payments" DROP CONSTRAINT "incoming_payments_match_result_check";
ALTER TABLE "finance"."incoming_payments" ADD CONSTRAINT "incoming_payments_match_result_check"
  CHECK ("match_result" IN ('MATCHED', 'PARTIAL_OVERPAYMENT',
    'NO_VARIABLE_SYMBOL', 'UNKNOWN_VARIABLE_SYMBOL', 'CURRENCY_MISMATCH', 'ENVIRONMENT_MISMATCH',
    'INVOICE_CANCELLED', 'INVOICE_ALREADY_PAID', 'PAID_BEFORE_ISSUE'));
