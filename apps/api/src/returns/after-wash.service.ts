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
import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';

type Tx = Prisma.TransactionClient;

const QUEUE_LIMIT = 500;
const READY_LIMIT = 100;

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

  /** The queue of the active site: waiting, set aside (revoked design) and ready. */
  async queue(site: SiteContext): Promise<AfterWashQueue> {
    const returned = await this.prisma.bottle.findMany({
      where: { siteId: site.siteId, status: 'RETURNED' },
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
    const open = await this.approvals.openDesigns([
      ...new Set(returned.flatMap((b) => (b.binding ? [b.binding.productId] : []))),
    ]);
    const waiting: AfterWashBottle[] = [];
    const withdrawn: AfterWashBottle[] = [];
    for (const b of returned) {
      const row: AfterWashBottle = {
        bottleCode: b.code,
        ...shown(b.binding),
        since: b.events[0]?.occurredAt.toISOString() ?? '',
        receipt: b.events[0]?.returnLine?.receipt.code ?? null,
      };
      const approved =
        !b.binding ||
        (open.get(b.binding.productId) ?? []).includes(b.binding.labelTemplateVersionId);
      (approved ? waiting : withdrawn).push(row);
    }
    const [readyCount, ready] = await Promise.all([
      this.prisma.bottle.count({ where: { siteId: site.siteId, status: 'READY_FOR_REUSE' } }),
      this.prisma.bottleEvent.findMany({
        where: { type: 'REUSE_READY', bottle: { siteId: site.siteId, status: 'READY_FOR_REUSE' } },
        orderBy: { id: 'desc' },
        take: READY_LIMIT,
        select: {
          occurredAt: true,
          payload: true,
          bottle: { select: { code: true, binding: { select: bindingSelect } } },
        },
      }),
    ]);
    return {
      waiting: waiting.slice(0, QUEUE_LIMIT),
      withdrawn: withdrawn.slice(0, QUEUE_LIMIT),
      ready: ready.map((e) => ({
        bottleCode: e.bottle.code,
        ...shown(e.bottle.binding),
        since: e.occurredAt.toISOString(),
        receipt: (e.payload as { receipt?: string | null } | null)?.receipt ?? null,
      })),
      counts: { waiting: waiting.length, withdrawn: withdrawn.length, ready: readyCount },
    };
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
