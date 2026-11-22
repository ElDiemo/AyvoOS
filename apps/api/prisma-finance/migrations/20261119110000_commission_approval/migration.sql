-- Sales commissions PR 2c (doc 069 §5d; owner OK GO 2026-11-18 for DEV with synthetic TEST data):
-- approving one salesperson's statement is an idempotent operation per request id. The tables,
-- their order, balance and storno invariants exist since 20261119100000_commission_statements.
BEGIN;

ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION',
                    'ISSUER_VERSION', 'ISSUER_ACCOUNT_CREATE', 'ISSUER_ACCOUNT_VERSION',
                    'ISSUER_DEFAULT_ACCOUNT', 'INVOICE_TEST_ISSUE', 'INVOICE_TEST_CANCEL', 'INVOICE_TEST_RUN',
                    'PAYMENTS_SIMULATE', 'PAYMENTS_IMPORT_BANK', 'PAYMENT_ALLOCATE',
                    'INVOICE_DELIVERY_REQUEST', 'INVOICE_DELIVERY_RETRY',
                    'BILLING_RUN_SETTINGS_VERSION', 'BILLING_TERMS_RESTORE',
                    'COMMISSION_STATEMENT_APPROVE'));

COMMIT;
