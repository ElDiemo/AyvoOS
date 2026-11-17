import { Injectable, NotFoundException } from '@nestjs/common';
import {
  parseCommissionRate,
  type CommissionTerms,
  type CommissionTermsOverviewRow,
  type CommissionTermsVersion,
  type RecordCommissionTermsRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { SalespeopleService } from '../sales/salespeople.service.js';

type Db = Prisma.TransactionClient;
type TermsRow = Prisma.SalesCommissionTermsGetPayload<{ include: { recorder: true } }>;

const MAX_INT = 2_147_483_647;

const toVersion = (r: TermsRow): CommissionTermsVersion => ({
  version: r.version,
  initialRate: r.initialRate.toFixed(2),
  initialMonths: r.initialMonths,
  maintenanceRate: r.maintenanceRate.toFixed(2),
  reason: r.reason,
  recordedAt: r.recordedAt.toISOString(),
  recordedByName: r.recorder.displayName,
});

const rateInvalid = (field: string) =>
  domainError(
    422,
    'TERMS_RATE_INVALID',
    `${field}: zadejte 0–100 % s nejvýš 2 desetinnými místy (nezaokrouhluje se).`,
  );

/**
 * Commission terms per salesperson (doc 068 §3.1, ADR 0046 §2a — PR 1a). Append-only
 * versions; the newest is the valid version. Only `sales:commission_terms_manage` (ADMIN only,
 * never a custom role — doc 068 §8.1) records or reads others' terms; a salesperson reads their
 * own through `mine`, always the session's user, never one named in the request.
 */
@Injectable()
export class CommissionTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly salespeople: SalespeopleService,
  ) {}

  /** The caller's own terms, read-only (sales:work). */
  mine(p: Principal): Promise<CommissionTerms> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: p.userId } });
      return this.termsOf(tx, { id: user.id, name: user.displayName });
    });
  }

  /** Every current salesperson with their valid version (manage). */
  overview(): Promise<CommissionTermsOverviewRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const people = await this.salespeople.list(tx);
      const rows = await tx.salesCommissionTerms.findMany({
        where: { salespersonId: { in: people.map((x) => x.id) } },
        include: { recorder: true },
        orderBy: [{ salespersonId: 'asc' }, { version: 'desc' }],
        distinct: ['salespersonId'],
      });
      const valid = new Map(rows.map((r) => [r.salespersonId, toVersion(r)]));
      return people.map((s) => ({
        salesperson: { id: s.id, name: s.name },
        valid: valid.get(s.id) ?? null,
      }));
    });
  }

  /** One person's terms and history (manage): a current salesperson, or anyone with history. */
  forSalesperson(id: string): Promise<CommissionTerms> {
    return this.prisma.$transaction(async (tx) => {
      const person = await this.salespeople.find(tx, id);
      if (person) return this.termsOf(tx, person);
      const any = await tx.salesCommissionTerms.findFirst({ where: { salespersonId: id } });
      const user = any ? await tx.user.findUnique({ where: { id } }) : null;
      if (!user) throw new NotFoundException('Salesperson not found');
      return this.termsOf(tx, { id: user.id, name: user.displayName });
    });
  }

  /**
   * A new version. Serialised per salesperson (advisory lock, then expectedVersion → 409);
   * idempotent per requestId. Rates are refused, never rounded. No hotel is touched: bound hotels
   * keep their snapshot (PR 1b), and this version applies to hotels attributed from now on.
   */
  async record(req: RecordCommissionTermsRequest, p: Principal): Promise<CommissionTerms> {
    const initialRate = parseCommissionRate(req.initialRate);
    if (initialRate === null) throw rateInvalid('Počáteční sazba');
    const maintenanceRate = parseCommissionRate(req.maintenanceRate);
    if (maintenanceRate === null) throw rateInvalid('Udržovací sazba');
    if (
      !Number.isInteger(req.initialMonths) ||
      req.initialMonths < 1 ||
      req.initialMonths > MAX_INT
    )
      throw domainError(
        422,
        'TERMS_MONTHS_INVALID',
        'Délku počáteční sazby zadejte v celých měsících (alespoň 1).',
      );
    const { result } = await this.operations.run(
      'SALES_COMMISSION_TERMS_RECORD',
      req.requestId,
      { ...req, actorId: p.userId },
      async (tx) => {
        const key = `sales-terms:${req.salespersonId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const person = await this.salespeople.find(tx, req.salespersonId);
        if (!person)
          throw domainError(
            422,
            'SALESPERSON_NOT_ELIGIBLE',
            'Podmínky lze nastavit jen aktivnímu uživateli s oprávněním Obchod.',
          );
        const last = await tx.salesCommissionTerms.findFirst({
          where: { salespersonId: req.salespersonId },
          orderBy: { version: 'desc' },
        });
        const current = last?.version ?? 0;
        if (current !== req.expectedVersion)
          throw domainError(
            409,
            'CONCURRENT_CHANGE',
            'Podmínky mezitím změnil někdo jiný. Načtěte je znovu.',
          );
        await tx.salesCommissionTerms.create({
          data: {
            salespersonId: req.salespersonId,
            version: current + 1,
            initialRate,
            initialMonths: req.initialMonths,
            maintenanceRate,
            reason: req.reason,
            recordedBy: p.userId,
            requestId: req.requestId,
          },
        });
        return { salespersonId: req.salespersonId };
      },
    );
    return this.forSalesperson(result.salespersonId);
  }

  private async termsOf(db: Db, person: { id: string; name: string }): Promise<CommissionTerms> {
    const rows = await db.salesCommissionTerms.findMany({
      where: { salespersonId: person.id },
      include: { recorder: true },
      orderBy: { version: 'desc' },
    });
    const history = rows.map(toVersion);
    return { salesperson: person, valid: history[0] ?? null, history };
  }
}
