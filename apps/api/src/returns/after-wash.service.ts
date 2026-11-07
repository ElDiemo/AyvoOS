import type {
  AfterWashBottle,
  AfterWashQueue,
  AfterWashScanResult,
  ReturnScanRequest,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
import { ProductLabelApprovalsService } from '../catalog/product-label-approvals.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { QrRegistryService } from '../database/qr-registry.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';

type Tx = Prisma.TransactionClient;

/**
 * Rows per list of the queue, applied in the database (the counts are exact and separate). Tests
 * lower them to exercise a queue longer than a list.
 */
export const AFTER_WASH_LIMITS = { list: 500, ready: 100 };

/** The binding as shown: product and label design (template name and version). */
const bindingSelect = {
  productId: true,
  labelTemplateVersionId: true,
  product: { select: { code: true, name: true } },
  labelTemplateVersion: { select: { versionNumber: true, template: { select: { name: true } } } },
} as const;
type BindingRow = Prisma.BottleProductBindingGetPayload<{ select: typeof bindingSelect }>;

const shown = (binding: BindingRow | null) => ({
  product: binding ? { code: binding.product.code, name: binding.product.name } : null,
  design: binding
    ? `${binding.labelTemplateVersion.template.name} v${binding.labelTemplateVersion.versionNumber}`
    : null,
});

/**
 * R2 "Po mytí" (doc 048 §1–§2): the second scan, of a bottle physically washed and inspected
 * after its return. RETURNED → READY_FOR_REUSE with one REUSE_READY, the open pump attachment
 * closed for cleaning, nothing consumed; the same QR, code and product binding. A bottle whose
 * label design is no longer approved for its product is set aside ("Vyčleněno – odvolaná
 * etiketa") and refused (DESIGN_WITHDRAWN) — never retired automatically. No crate, no station:
 * in R2 a READY_FOR_REUSE bottle enters no crate (the placement comes with R3's refilling).
 * Lock order: operation request → bottle → design approval (share).
 */
@Injectable()
export class AfterWashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly registry: QrRegistryService,
    private readonly bottles: BottlesService,
    private readonly approvals: ProductLabelApprovalsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * The queue of the active site: waiting, set aside (revoked design) and ready. Each list is
   * limited in the database by its own condition, so a long first group never hides the second;
   * the counts are separate aggregates.
   */
  async queue(site: SiteContext): Promise<AfterWashQueue> {
    // RETURNED bottles of the site, each with "is its design still approved for its product?"
    // (a bottle without a binding cannot be set aside for its design: it waits, and its scan says
    // why it is refused).
    const groups = Prisma.sql`
      SELECT b."id", b."serial",
             (pb."bottle_id" IS NULL OR EXISTS (
                SELECT 1 FROM "product_label_approvals" a
                 WHERE a."product_id" = pb."product_id"
                   AND a."label_template_version_id" = pb."label_template_version_id"
                   AND a."revoked_at" IS NULL)) AS "approved"
        FROM "bottles" b LEFT JOIN "bottle_product_bindings" pb ON pb."bottle_id" = b."id"
       WHERE b."site_id" = ${site.siteId}::uuid AND b."status" = 'RETURNED'`;
    const limit = AFTER_WASH_LIMITS.list;
    const [counts, waitingIds, withdrawnIds] = await Promise.all([
      this.prisma.$queryRaw<{ approved: boolean; n: bigint }[]>`
        SELECT g."approved", count(*) AS "n" FROM (${groups}) g GROUP BY g."approved"`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT g."id" FROM (${groups}) g WHERE g."approved" ORDER BY g."serial" LIMIT ${limit}`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT g."id" FROM (${groups}) g WHERE NOT g."approved" ORDER BY g."serial" LIMIT ${limit}`,
    ]);
    const count = (approved: boolean) =>
      Number(counts.find((c) => c.approved === approved)?.n ?? 0);
    const [waiting, withdrawn, readyCount, ready] = await Promise.all([
      this.returnedRows(waitingIds.map((r) => r.id)),
      this.returnedRows(withdrawnIds.map((r) => r.id)),
      this.prisma.bottle.count({ where: { siteId: site.siteId, status: 'READY_FOR_REUSE' } }),
      this.prisma.bottleEvent.findMany({
        where: { type: 'REUSE_READY', bottle: { siteId: site.siteId, status: 'READY_FOR_REUSE' } },
        orderBy: { id: 'desc' },
        take: AFTER_WASH_LIMITS.ready,
        select: {
          occurredAt: true,
          payload: true,
          bottle: { select: { code: true, binding: { select: bindingSelect } } },
        },
      }),
    ]);
    return {
      waiting,
      withdrawn,
      ready: ready.map((e) => ({
        bottleCode: e.bottle.code,
        ...shown(e.bottle.binding),
        since: e.occurredAt.toISOString(),
        receipt: (e.payload as { receipt?: string | null } | null)?.receipt ?? null,
      })),
      counts: { waiting: count(true), withdrawn: count(false), ready: readyCount },
    };
  }

  /** The shown rows of these (already limited) RETURNED bottles, in serial order. */
  private async returnedRows(ids: string[]): Promise<AfterWashBottle[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.bottle.findMany({
      where: { id: { in: ids } },
      orderBy: { serial: 'asc' },
      select: {
        code: true,
        binding: { select: bindingSelect },
        events: {
          where: { type: { in: ['SORTED', 'CORRECTION'] } },
          orderBy: { id: 'desc' },
          take: 1,
          select: {
            occurredAt: true,
            returnLine: { select: { receipt: { select: { code: true } } } },
          },
        },
      },
    });
    return rows.map((b) => ({
      bottleCode: b.code,
      ...shown(b.binding),
      since: b.events[0]?.occurredAt.toISOString() ?? '',
      receipt: b.events[0]?.returnLine?.receipt.code ?? null,
    }));
  }

  /** "Po mytí": one scan of one washed and inspected bottle of the active site. */
  async scan(
    principal: Principal,
    site: SiteContext,
    input: ReturnScanRequest,
  ): Promise<AfterWashScanResult> {
    const token = this.token(input.scannedValue);
    const { result } = await this.operations.run(
      'REUSE_READY_SCAN',
      input.requestId,
      { actorId: principal.userId, siteId: site.siteId, token },
      async (tx) => {
        const bottle = await this.bottleOf(tx, token);
        // The site boundary first: nothing of another site is changed or named.
        if (bottle.siteId !== site.siteId) {
          throw domainError(409, 'BOTTLE_OF_ANOTHER_SITE', 'This bottle belongs to another site');
        }
        const status = await this.bottles.lockForLabelApplication(tx, bottle.id);
        const binding = await tx.bottleProductBinding.findUnique({
          where: { bottleId: bottle.id },
          select: bindingSelect,
        });
        // Scanned again after "Po mytí" (another request): the first result, nothing written.
        if (status === 'READY_FOR_REUSE') {
          const first = await tx.bottleEvent.findFirstOrThrow({
            where: { bottleId: bottle.id, type: 'REUSE_READY' },
            orderBy: { id: 'desc' },
            select: { occurredAt: true },
          });
          return {
            outcome: 'READY_FOR_REUSE',
            repeated: true,
            bottleCode: bottle.code,
            ...shown(binding),
            readyAt: first.occurredAt.toISOString(),
          };
        }
        if (status !== 'RETURNED') {
          throw domainErrorWithDetails(
            409,
            'NOT_RETURNED',
            'Only a bottle received from a return and waiting for washing is scanned here',
            { bottle: bottle.code, status },
          );
        }
        if (!binding) {
          throw domainError(409, 'NO_PRODUCT_BINDING', 'This bottle has no product binding');
        }
        // A revoked design: set aside for an explicit decision (doc 048 D2), nothing written.
        if (
          !(await this.approvals.lockOpen(tx, binding.productId, binding.labelTemplateVersionId))
        ) {
          throw domainErrorWithDetails(
            409,
            'DESIGN_WITHDRAWN',
            'The label design of this bottle is no longer approved: set aside, not ready for reuse',
            { bottle: bottle.code },
          );
        }
        const returnEvent = await tx.bottleEvent.findFirst({
          where: { bottleId: bottle.id, type: { in: ['SORTED', 'CORRECTION'] } },
          orderBy: { id: 'desc' },
          select: { returnLine: { select: { receipt: { select: { code: true } } } } },
        });
        const now = new Date();
        await this.bottles.readyAfterWash(tx, {
          bottleId: bottle.id,
          actorId: principal.userId,
          operationRequestId: input.requestId,
          occurredAt: now,
          receipt: returnEvent?.returnLine?.receipt.code ?? null,
        });
        return {
          outcome: 'READY_FOR_REUSE',
          repeated: false,
          bottleCode: bottle.code,
          ...shown(binding),
          readyAt: now.toISOString(),
        };
      },
    );
    return result as unknown as AfterWashScanResult;
  }

  private token(scannedValue: string): string {
    const scan = classifyScannedQr(scannedValue, this.env.PUBLIC_QR_BASE_URL);
    if (scan.kind === 'NOT_AYVO_QR') {
      throw domainError(422, 'NOT_AYVO_QR', 'This is not an AYVO QR code of this environment');
    }
    if (scan.kind === 'WRONG_ENVIRONMENT') {
      throw domainError(
        422,
        'WRONG_ENVIRONMENT',
        'This QR code belongs to another AYVO environment',
      );
    }
    return scan.token;
  }

  private async bottleOf(tx: Tx, token: string) {
    const kind = await this.registry.kindOf(token, tx);
    if (kind && kind !== 'BOTTLE') {
      throw domainError(422, 'NOT_A_BOTTLE', 'This is not a bottle QR code');
    }
    const bottle = await this.bottles.findByPublicToken(tx, token);
    if (!bottle) throw domainError(422, 'UNKNOWN_LABEL', 'No bottle has this label');
    return bottle;
  }
}
