/**
 * Terms revisions of billing agreements (v6, #148): the reads both the terms service and the
 * agreement page / the portal check use. The writes are in billing-terms.service.ts.
 */
import type { BillingPendingTransfer } from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import type { Prisma } from '../generated/finance-prisma/client.js';
import type { FinancePrismaService } from './finance-prisma.service.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | FinancePrismaService;

const day = (d: Date) => d.toISOString().slice(0, 10);

export const termsChangePending = () =>
  domainError(
    409,
    'TERMS_CHANGE_PENDING',
    'Smlouva má rozpracovanou změnu plátce. Nejdřív ji dokončete nebo zrušte.',
  );

/** The next terms revision of the agreement: after every reserved revision and every version. */
export async function nextTermsRevision(tx: Tx, agreementId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT GREATEST(
      COALESCE((SELECT max("revision") FROM "finance"."billing_terms_revisions" WHERE "agreement_id" = ${agreementId}::uuid), 0),
      COALESCE((SELECT max("terms_revision") FROM "finance"."agreement_versions" WHERE "agreement_id" = ${agreementId}::uuid), 0)
    )::int + 1 AS "n"`;
  return rows[0]!.n;
}

/**
 * The agreement's terms revision now, for a grant's check (v6): the highest revision reserved or
 * recorded — an abandoned transfer's too, its fence stays. While a transfer is reserved and not
 * settled the check is refused: its fence may be on its way.
 */
export async function checkedTermsRevision(db: Db, agreementId: string): Promise<number> {
  if (await pendingTransferRow(db, agreementId)) throw termsChangePending();
  const [r, v] = await Promise.all([
    db.billingTermsRevision.aggregate({ where: { agreementId }, _max: { revision: true } }),
    db.agreementVersion.aggregate({ where: { agreementId }, _max: { termsRevision: true } }),
  ]);
  return Math.max(r._max.revision ?? 0, v._max.termsRevision ?? 0);
}

export function pendingTransferRow(db: Db, agreementId: string) {
  return db.billingTermsRevision.findFirst({
    where: {
      agreementId,
      intent: 'TRANSFER',
      events: { none: { kind: { in: ['COMMITTED', 'ABANDONED'] } } },
    },
    include: { payer: true },
  });
}

/** The agreement page's reserved, unsettled transfer (null: none). */
export async function pendingTransferOf(
  db: Db,
  agreementId: string,
): Promise<BillingPendingTransfer | null> {
  const r = await pendingTransferRow(db, agreementId);
  return r
    ? {
        termsRevision: r.revision,
        leavingPayer: { id: r.payer.id, code: r.payer.code },
        fenceEndsOn: day(r.fenceEndsOn!),
        reason: r.reason,
        recordedAt: r.recordedAt.toISOString(),
        recordedByName: r.recordedByName,
      }
    : null;
}
