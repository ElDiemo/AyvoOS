import { Injectable } from '@nestjs/common';
import { idempotencyConflict } from '../common/domain-error.js';
import { payloadHash } from '../database/operation-requests.service.js';
import type { Prisma } from '../generated/finance-prisma/client.js';
import { FinancePrismaService } from './finance-prisma.service.js';

export type FinanceOperationKind =
  | 'FINANCE_DOCUMENT_RECEIVE'
  | 'FINANCE_DOCUMENT_TAKEOVER'
  | 'ACCOUNTING_EXPORT_CREATE'
  | 'ACCOUNTING_EXPORT_HANDOVER'
  | 'BILLING_CUSTOMER_CREATE'
  | 'BILLING_CUSTOMER_VERSION'
  | 'BILLING_PRICE_VERSION'
  | 'BILLING_AGREEMENT_CREATE'
  | 'BILLING_AGREEMENT_VERSION'
  | 'ISSUER_VERSION'
  | 'ISSUER_ACCOUNT_CREATE'
  | 'ISSUER_ACCOUNT_VERSION'
  | 'ISSUER_DEFAULT_ACCOUNT';

/**
 * The core's idempotency pattern (doc 018 §8) in Finance's own schema: one transaction inserts
 * the request row first, runs the work and stores its result. A concurrent duplicate waits on
 * the primary key and then replays; the same id with another payload is IDEMPOTENCY_CONFLICT; a
 * failed attempt rolls back entirely, so the same id may be retried.
 */
@Injectable()
export class FinanceOperations {
  constructor(private readonly prisma: FinancePrismaService) {}

  run<R extends Prisma.InputJsonValue>(
    kind: FinanceOperationKind,
    requestId: string,
    payload: unknown,
    work: (tx: Prisma.TransactionClient) => Promise<R>,
  ): Promise<{ result: R; replayed: boolean }> {
    const hash = payloadHash(kind, payload);
    return this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO "finance"."operation_requests" ("request_id", "kind", "payload_sha256")
          VALUES (${requestId}::uuid, ${kind}, ${hash})
          ON CONFLICT ("request_id") DO NOTHING`;
        if (inserted === 0) {
          const row = await tx.operationRequest.findUnique({ where: { requestId } });
          if (!row || row.kind !== kind || row.payloadSha256 !== hash || row.result === null)
            throw idempotencyConflict();
          return { result: row.result as R, replayed: true };
        }
        const result = await work(tx);
        await tx.operationRequest.update({ where: { requestId }, data: { result } });
        return { result, replayed: false };
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
  }
}

/** Gapless serials from finance.code_counters (inside the business transaction). */
export async function allocateFinanceSerial(
  tx: Prisma.TransactionClient,
  name:
    | 'finance_document'
    | 'accounting_export'
    | 'customer'
    | 'billing_agreement'
    | 'billing_revision'
    | 'issuer_bank_account',
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ last_value: bigint }[]>`
    UPDATE "finance"."code_counters" SET "last_value" = "last_value" + 1
    WHERE "name" = ${name} RETURNING "last_value"`;
  const value = rows[0]?.last_value;
  if (value === undefined) throw new Error(`Finance code counter "${name}" is missing`);
  return value;
}
