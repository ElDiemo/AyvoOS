-- Read-only preflight before returning the web (or Finance) to an image older than PR #110
-- (doc 041 §8b): incoming payments whose match result such an image does not know. Its web parses
-- the result strictly, so with any row here its payment pages fail (data stay intact, nothing is
-- deleted — append-only). Run inside BEGIN READ ONLY; expected answer on PROD before live
-- invoices: no row.
SELECT p."match_result", count(*)::int AS "payments"
FROM "finance"."incoming_payments" p
WHERE p."match_result" NOT IN ('MATCHED', 'PARTIAL_OVERPAYMENT', 'NO_VARIABLE_SYMBOL',
  'UNKNOWN_VARIABLE_SYMBOL', 'CURRENCY_MISMATCH', 'ENVIRONMENT_MISMATCH', 'INVOICE_CANCELLED',
  'INVOICE_ALREADY_PAID')
GROUP BY p."match_result"
ORDER BY p."match_result";
