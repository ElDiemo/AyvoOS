import type {
  ApproveProductLabelRequest,
  ProductLabelApproval,
  RevokeProductLabelRequest,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { isUniqueViolation } from '../common/unique-violation.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';

const include = {
  approver: { select: { displayName: true } },
  revoker: { select: { displayName: true } },
} satisfies Prisma.ProductLabelApprovalInclude;
type ApprovalRecord = Prisma.ProductLabelApprovalGetPayload<{ include: typeof include }>;

/**
 * Approved label designs per product (owner B1, doc 020 §3.3): an exact label template version
 * approved for exactly ONE product. A labelling station binds a bottle to the product whose
 * approved design was printed on its label. Revoking blocks new labelling only; history stays.
 */
@Injectable()
export class ProductLabelApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly labels: LabelTemplatesService,
    private readonly audit: AuditService,
  ) {}

  async list(productCode: string): Promise<ProductLabelApproval[]> {
    const product = await this.product(productCode);
    const rows = await this.prisma.productLabelApproval.findMany({
      where: { productId: product.id },
      include,
      orderBy: { approvedAt: 'desc' },
    });
    return this.toDtos(rows);
  }

  async approve(
    actorId: string,
    productCode: string,
    input: ApproveProductLabelRequest,
  ): Promise<ProductLabelApproval> {
    const { result } = await this.operations.run(
      'PRODUCT_LABEL_APPROVE',
      input.requestId,
      { actorId, productCode, ...input, requestId: undefined },
      async (tx) => {
        const product = await this.product(productCode, tx);
        if (product.status !== 'ACTIVE') {
          throw domainError(
            409,
            'PRODUCT_ARCHIVED',
            'An archived product gets no new label design',
          );
        }
        if ((await this.labels.getVersionRefs([input.labelTemplateVersionId])).size === 0) {
          throw domainError(422, 'UNKNOWN_LABEL_DESIGN', 'Unknown label template version');
        }
        const open = await tx.productLabelApproval.findFirst({
          where: { labelTemplateVersionId: input.labelTemplateVersionId, revokedAt: null },
          include: { product: { select: { code: true } } },
        });
        if (open) throw designTaken(open.product.code);
        let row: ApprovalRecord;
        try {
          row = await tx.productLabelApproval.create({
            data: {
              productId: product.id,
              labelTemplateVersionId: input.labelTemplateVersionId,
              reason: input.reason,
              approvedBy: actorId,
              approveOperationId: input.requestId,
            },
            include,
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw designTaken(null);
          throw error;
        }
        await this.audit.record(
          {
            type: 'PRODUCT_LABEL_APPROVED',
            actorUserId: actorId,
            reason: input.reason,
            payload: { product: productCode, labelTemplateVersionId: input.labelTemplateVersionId },
          },
          tx,
        );
        return (await this.toDtos([row]))[0]!;
      },
    );
    return result;
  }

  async revoke(
    actorId: string,
    productCode: string,
    approvalId: string,
    input: RevokeProductLabelRequest,
  ): Promise<ProductLabelApproval> {
    const { result } = await this.operations.run(
      'PRODUCT_LABEL_REVOKE',
      input.requestId,
      { actorId, productCode, approvalId, reason: input.reason },
      async (tx) => {
        const product = await this.product(productCode, tx);
        const row = await tx.productLabelApproval.findUnique({ where: { id: approvalId } });
        if (!row || row.productId !== product.id) throw new NotFoundException('Approval not found');
        if (row.revokedAt) throw domainError(409, 'ALREADY_REVOKED', 'Already revoked');
        const updated = await tx.productLabelApproval.update({
          where: { id: approvalId },
          data: {
            revokedAt: new Date(),
            revokedBy: actorId,
            revokeReason: input.reason,
            revokeOperationId: input.requestId,
          },
          include,
        });
        await this.audit.record(
          {
            type: 'PRODUCT_LABEL_REVOKED',
            actorUserId: actorId,
            reason: input.reason,
            payload: { product: productCode, labelTemplateVersionId: row.labelTemplateVersionId },
          },
          tx,
        );
        return (await this.toDtos([updated]))[0]!;
      },
    );
    return result;
  }

  /** Is the design approved for the product right now (in the caller's transaction)? */
  async isOpen(
    tx: Prisma.TransactionClient,
    productId: string,
    labelTemplateVersionId: string,
  ): Promise<boolean> {
    return (
      (await tx.productLabelApproval.count({
        where: { productId, labelTemplateVersionId, revokedAt: null },
      })) > 0
    );
  }

  /** Open approvals of the given products: productId → design version ids. */
  async openDesigns(productIds: readonly string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.productLabelApproval.findMany({
      where: { productId: { in: [...productIds] }, revokedAt: null },
      orderBy: { approvedAt: 'asc' },
      select: { productId: true, labelTemplateVersionId: true },
    });
    const map = new Map<string, string[]>();
    for (const r of rows)
      map.set(r.productId, [...(map.get(r.productId) ?? []), r.labelTemplateVersionId]);
    return map;
  }

  private async product(code: string, db: Prisma.TransactionClient = this.prisma) {
    const product = await db.product.findUnique({ where: { code } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async toDtos(rows: ApprovalRecord[]): Promise<ProductLabelApproval[]> {
    const refs = await this.labels.getVersionRefs(rows.map((r) => r.labelTemplateVersionId));
    return rows.map((r) => ({
      id: r.id,
      design: refs.get(r.labelTemplateVersionId)!,
      reason: r.reason,
      approvedAt: r.approvedAt.toISOString(),
      approvedBy: r.approver.displayName,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      revokedBy: r.revoker?.displayName ?? null,
      revokeReason: r.revokeReason,
    }));
  }
}

const designTaken = (productCode: string | null) =>
  domainError(
    409,
    'DESIGN_APPROVED_FOR_ANOTHER_PRODUCT',
    productCode
      ? `This label design is already approved for product ${productCode}`
      : 'This label design is already approved for a product',
  );
