import type {
  PortalFence,
  PortalFenceRequest,
  PortalFenceResolutionRequest,
  PortalFenceResolutionResult,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** Today in Prague as `YYYY-MM-DD` (operational access is per calendar day, as the terms). */
export const pragueToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The hotel row lock — the one a grant issue/replace, a fence and a resolution all take. */
export async function lockHotels(tx: Tx, hotelIds: readonly string[]): Promise<void> {
  // A fixed order (by id), so two writers on overlapping hotels never deadlock.
  for (const id of [...new Set(hotelIds)].sort()) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "hotels" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
  }
}

/**
 * One hotel of a grant: operational now? (v6 §3, one condition per fence) — OPERATIONS, today at
 * most its own end, and for EVERY fence of the payer × hotel: today at most the fence's last day,
 * or the fence has a resolution and this grant was checked in its restore revision or later.
 */
export function isOperational(
  hotel: { access: string; checkedRevision: number | null; operationsUntil: Date | null },
  fences: readonly { endsOn: Date; resolution: { restoreRevision: number } | null }[],
  today: string,
): boolean {
  if (hotel.access !== 'OPERATIONS' || hotel.checkedRevision === null) return false;
  if (hotel.operationsUntil && today > day(hotel.operationsUntil)) return false;
  return fences.every(
    (f) =>
      today <= day(f.endsOn) ||
      (f.resolution !== null && hotel.checkedRevision! >= f.resolution.restoreRevision),
  );
}

const toView = (f: {
  id: string;
  payerCustomerId: string;
  hotelId: string;
  endsOn: Date;
  termsRevision: number;
  requestId: string;
  createdAt: Date;
}): PortalFence => ({
  id: f.id,
  payerCustomerId: f.payerCustomerId,
  hotelId: f.hotelId,
  endsOn: day(f.endsOn),
  termsRevision: f.termsRevision,
  requestId: f.requestId,
  createdAt: f.createdAt.toISOString(),
});

/**
 * The operational boundary's writes (v6, #148 comments 6773883145, 6773928715): only through
 * Finance's contract, each in one short transaction — the hotel's row lock, then the request row
 * (OperationRequestsService: the same request id gets the same stored result, another meaning
 * under it IDEMPOTENCY_CONFLICT). Fences and resolutions are append-only (DB). The core never
 * asks Finance: it checks only what the request says against its own rows.
 */
@Injectable()
export class PortalFencesService {
  constructor(private readonly operations: OperationRequestsService) {}

  /**
   * A fence, before Finance commits the change of payer. A retry with the same request id (the
   * answer was lost, or Finance had not stored the fence id yet) returns the same fence.
   */
  async fence(actorId: string, input: PortalFenceRequest): Promise<PortalFence> {
    const meaning = { actorId, ...input };
    const { result } = await this.operations.run(
      'PORTAL_FENCE_WRITE',
      input.requestId,
      meaning,
      async (tx) => {
        await lockHotels(tx, [input.hotelId]);
        const fence = await tx.portalOperationalFence.create({
          data: {
            payerCustomerId: input.payerCustomerId,
            hotelId: input.hotelId,
            endsOn: new Date(`${input.endsOn}T00:00:00.000Z`),
            termsRevision: input.termsRevision,
            requestId: input.requestId,
            reason: input.reason,
          },
        });
        return toView(fence) as unknown as Prisma.InputJsonObject;
      },
    );
    return result as unknown as PortalFence;
  }

  /**
   * The resolution of the named fences by one committed restore. Every fence must exist, be of
   * exactly this payer × hotel, be older than the restore revision and not be resolved by another
   * operation; otherwise 409 and nothing is written. The same restore again (its replay) gets the
   * stored result: one resolution per fence.
   */
  async resolve(
    actorId: string,
    input: PortalFenceResolutionRequest,
  ): Promise<PortalFenceResolutionResult> {
    const fenceIds = [...input.fenceIds].sort();
    const meaning = { actorId, ...input, fenceIds };
    const { result } = await this.operations.run(
      'PORTAL_FENCE_RESOLVE',
      input.restoreRequestId,
      meaning,
      async (tx) => {
        await lockHotels(tx, [input.hotelId]);
        const fences = await tx.portalOperationalFence.findMany({
          where: { id: { in: fenceIds } },
          include: { resolution: true },
        });
        const found = new Map(fences.map((f) => [f.id, f]));
        for (const id of fenceIds) {
          const f = found.get(id);
          if (!f || f.payerCustomerId !== input.payerCustomerId || f.hotelId !== input.hotelId)
            throw domainErrorWithDetails(
              409,
              'FENCE_NOT_OF_PAIR',
              'A named fence is not of this payer and hotel',
              { fenceId: id },
            );
          if (input.restoreRevision <= f.termsRevision)
            throw domainErrorWithDetails(
              409,
              'RESTORE_NOT_LATER',
              'A restore resolves only fences of an earlier terms revision',
              { fenceId: id, termsRevision: f.termsRevision },
            );
          if (f.resolution)
            throw domainErrorWithDetails(
              409,
              'FENCE_ALREADY_RESOLVED',
              'The fence was resolved by another restore',
              { fenceId: id },
            );
        }
        await tx.portalOperationalFenceResolution.createMany({
          data: fenceIds.map((fenceId) => ({
            fenceId,
            restoreRevision: input.restoreRevision,
            restoreRequestId: input.restoreRequestId,
          })),
        });
        return {
          restoreRequestId: input.restoreRequestId,
          restoreRevision: input.restoreRevision,
          fenceIds,
        } satisfies PortalFenceResolutionResult;
      },
    );
    return result as unknown as PortalFenceResolutionResult;
  }
}
