import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { idempotencyConflict } from '../common/domain-error.js';
import type { OperationKind, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** JSON with object keys sorted recursively, so equal payloads always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(kind: OperationKind, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, payload })).digest('hex');
}

export interface IdempotentOutcome<R> {
  result: R;
  /** true when the request id was already completed and its stored result is returned. */
  replayed: boolean;
}

/**
 * Runs one mutating operation exactly once per client request id (doc 018 §8).
 *
 * In ONE transaction: the request row is inserted first (lock order: operation_requests before
 * any business row), then `work` runs, then its result is stored. A concurrent duplicate waits on
 * the primary key and then sees the committed row. Same id + same payload → the stored result;
 * same id + different payload (or kind) → IDEMPOTENCY_CONFLICT. If `work` throws (a rejection
 * such as LOT_EXHAUSTED), everything rolls back including the request row, so the same request id
 * succeeds once the cause is fixed. Only successful outcomes are ever stored.
 */
@Injectable()
export class OperationRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  run<R extends Prisma.InputJsonValue>(
    kind: OperationKind,
    requestId: string,
    payload: unknown,
    work: (tx: Prisma.TransactionClient) => Promise<R>,
  ): Promise<IdempotentOutcome<R>> {
    const hash = payloadHash(kind, payload);
    return this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO "operation_requests" ("request_id", "kind", "payload_sha256")
          VALUES (${requestId}::uuid, ${kind}::"OperationKind", ${hash})
          ON CONFLICT ("request_id") DO NOTHING`;
        if (inserted === 0) {
          const row = await tx.operationRequest.findUnique({ where: { requestId } });
          if (!row || row.kind !== kind || row.payloadSha256 !== hash || row.result === null) {
            throw idempotencyConflict();
          }
          return { result: row.result as R, replayed: true };
        }
        const result = await work(tx);
        await tx.operationRequest.update({ where: { requestId }, data: { result } });
        return { result, replayed: false };
      },
      // Concurrent scans queue on row locks; give them room instead of failing fast.
      { maxWait: 20_000, timeout: 30_000 },
    );
  }
}
