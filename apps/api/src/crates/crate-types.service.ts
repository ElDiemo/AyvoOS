import type { CrateType, CreateCrateTypeRequest } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { isUniqueViolation } from '../common/unique-violation.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const crateTypeInclude = {
  categories: { include: { category: true }, orderBy: { categoryCode: 'asc' as const } },
} satisfies Prisma.CrateTypeInclude;
export type CrateTypeRecord = Prisma.CrateTypeGetPayload<{ include: typeof crateTypeInclude }>;

export const toCrateType = (c: CrateTypeRecord): CrateType => ({
  code: c.code,
  name: c.name,
  capacity: c.capacity,
  categories: c.categories.map((x) => ({ code: x.category.code, name: x.category.name })),
});

const crateCodeTaken = () =>
  domainError(409, 'CODE_TAKEN', 'A crate type with this code already exists');

/**
 * Returnable crate types (ADR 0021, doc 023): capacity is data on the type — never a constant —
 * and immutable; the categories it carries are fixed at creation. Company-wide, like the product
 * catalogue. Crates, their QR identities and cycles are a later phase (doc 020 §14).
 */
@Injectable()
export class CrateTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CrateType[]> {
    const rows = await this.prisma.crateType.findMany({
      include: crateTypeInclude,
      orderBy: { code: 'asc' },
    });
    return rows.map(toCrateType);
  }

  byCode(code: string, db: Prisma.TransactionClient = this.prisma) {
    return db.crateType.findUnique({ where: { code }, include: crateTypeInclude });
  }

  byId(id: string, db: Prisma.TransactionClient = this.prisma) {
    return db.crateType.findUniqueOrThrow({ where: { id }, include: crateTypeInclude });
  }

  /** Idempotent per request id; the type, its categories and the audit event commit together. */
  async create(actorId: string, input: CreateCrateTypeRequest): Promise<CrateType> {
    const { result } = await this.operations.run(
      'CRATE_TYPE_CREATE',
      input.requestId,
      input,
      async (tx) => {
        const known = await tx.productCategory.count({
          where: { code: { in: input.categoryCodes } },
        });
        if (known !== input.categoryCodes.length) {
          throw domainError(422, 'UNKNOWN_CATEGORY', 'Unknown product category');
        }
        if (await this.byCode(input.code, tx)) throw crateCodeTaken();
        let created: CrateTypeRecord;
        try {
          created = await tx.crateType.create({
            data: {
              code: input.code,
              name: input.name,
              capacity: input.capacity,
              createdBy: actorId,
              operationRequestId: input.requestId,
              categories: { create: input.categoryCodes.map((categoryCode) => ({ categoryCode })) },
            },
            include: crateTypeInclude,
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw crateCodeTaken();
          throw error;
        }
        await this.audit.record(
          {
            type: 'CRATE_TYPE_CREATED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              crateType: created.code,
              name: created.name,
              capacity: created.capacity,
              categories: [...input.categoryCodes].sort(),
              requestId: input.requestId,
            },
          },
          tx,
        );
        return toCrateType(created);
      },
    );
    return result;
  }
}
