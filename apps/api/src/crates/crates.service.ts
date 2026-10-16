import type {
  CrateDetail,
  CrateListQuery,
  CratePage,
  CrateRegistration,
  CrateSummary,
  RegisterCratesRequest,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { generatePublicToken } from '../assets/public-token.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { CrateTypesService } from './crate-types.service.js';

const crateInclude = {
  crateType: true,
  site: { select: { code: true, name: true } },
  registration: { select: { code: true } },
} satisfies Prisma.CrateInclude;
type CrateRecord = Prisma.CrateGetPayload<{ include: typeof crateInclude }>;

const crateNotFound = () => new NotFoundException('Crate not found');

/**
 * Physical returnable crates (doc 020 §3.4, ADR 0021 §6, doc 025 A1): registration, list and
 * detail. A crate belongs to the site it was registered at (doc 022); another site's crate is
 * "not found". The crate's QR token is generated here (128 random bits, ADR 0014) and registered
 * in the shared QR registry by the database, so it never equals a bottle's token.
 */
@Injectable()
export class CratesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly crateTypes: CrateTypesService,
  ) {}

  /** Registers 1–1000 crates of one type at the active site; idempotent per request id. */
  async register(
    actorId: string,
    input: RegisterCratesRequest,
    site: SiteContext,
  ): Promise<CrateRegistration> {
    const { result } = await this.operations.run(
      'CRATE_REGISTER',
      input.requestId,
      // Bound to the author and the site: a replay by someone else or elsewhere is a conflict.
      {
        actorId,
        siteId: site.siteId,
        crateTypeCode: input.crateTypeCode,
        quantity: input.quantity,
      },
      async (tx) => {
        const type = await this.crateTypes.byCode(input.crateTypeCode, tx);
        if (!type) throw domainError(422, 'UNKNOWN_CRATE_TYPE', 'Unknown crate type');
        // Counter lock order: crate_registration → crate (code-counters.ts).
        const { first: regSerial } = await allocateSerials(tx, 'crate_registration', 1);
        const crates = await allocateSerials(tx, 'crate', input.quantity);
        const registration = await tx.crateRegistration.create({
          data: {
            serial: regSerial,
            code: formatCode(CODE_PREFIX.crateRegistration, regSerial),
            crateTypeId: type.id,
            quantity: input.quantity,
            firstCrateSerial: crates.first,
            lastCrateSerial: crates.last,
            siteId: site.siteId,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
          include: { site: { select: { code: true, name: true } } },
        });
        const rows = Array.from({ length: input.quantity }, (_, i) => {
          const serial = crates.first + BigInt(i);
          return {
            serial,
            code: formatCode(CODE_PREFIX.crate, serial),
            qrToken: generatePublicToken(),
            crateTypeId: type.id,
            registrationId: registration.id,
            siteId: site.siteId,
          };
        });
        await tx.crate.createMany({ data: rows });
        const created = await tx.crate.findMany({
          where: { registrationId: registration.id },
          select: { id: true, code: true },
          orderBy: { serial: 'asc' },
        });
        const occurredAt = new Date();
        await tx.crateEvent.createMany({
          data: created.map((c) => ({
            crateId: c.id,
            type: 'REGISTERED' as const,
            occurredAt,
            actorId,
            siteId: site.siteId,
            // Registration records the site only — not where the crate physically is.
            locationId: null,
            operationRequestId: input.requestId,
            registrationId: registration.id,
          })),
        });
        return {
          code: registration.code,
          crateType: { code: type.code, name: type.name, capacity: type.capacity },
          quantity: registration.quantity,
          site: registration.site,
          crateCodes: created.map((c) => c.code),
          createdAt: registration.createdAt.toISOString(),
        } satisfies CrateRegistration;
      },
    );
    return result;
  }

  async list(siteId: string, query: CrateListQuery): Promise<CratePage> {
    const where: Prisma.CrateWhereInput = { siteId };
    if (query.search) {
      const serial = parseCodeSerial(CODE_PREFIX.crate, query.search);
      // An unparsable search matches nothing (never "everything").
      where.serial = serial ?? -1n;
    }
    if (query.crateType) where.crateType = { code: query.crateType };
    if (query.state) {
      where.cycles =
        query.state === 'EMPTY'
          ? { none: { status: { not: 'ABORTED' } } }
          : { some: { status: query.state } };
    }
    const [total, rows, stateCounts] = await Promise.all([
      this.prisma.crate.count({ where }),
      this.prisma.crate.findMany({
        where,
        include: crateInclude,
        orderBy: { serial: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.stateCounts(siteId),
    ]);
    const facts = await this.eventFacts(rows.map((r) => r.id));
    return {
      items: rows.map((r) => toSummary(r, facts.get(r.id)!)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      stateCounts,
    };
  }

  /** Crates of the site per derived state: EMPTY (no open cycle) or the open cycle's status. */
  private async stateCounts(siteId: string): Promise<CratePage['stateCounts']> {
    const [crates, open] = await Promise.all([
      this.prisma.crate.count({ where: { siteId } }),
      this.prisma.crateCycle.groupBy({
        by: ['status'],
        where: { siteId, status: { not: 'ABORTED' } },
        _count: { _all: true },
      }),
    ]);
    const counts = { EMPTY: crates, OPEN_ASSEMBLY: 0, READY_TO_FILL: 0, FILLING: 0, FILLED: 0 };
    for (const row of open) {
      if (row.status === 'ABORTED') continue;
      counts[row.status] = row._count._all;
      counts.EMPTY -= row._count._all;
    }
    return counts;
  }

  /** A crate of the given site by code; another site's crate is "not found" (doc 022). */
  async findOfSite(code: string, siteId: string, db: Prisma.TransactionClient = this.prisma) {
    const serial = parseCodeSerial(CODE_PREFIX.crate, code);
    const crate =
      serial === null
        ? null
        : await db.crate.findUnique({ where: { serial }, include: crateInclude });
    if (!crate || crate.siteId !== siteId) throw crateNotFound();
    return crate;
  }

  async detail(
    code: string,
    siteId: string,
    printJobs: CrateDetail['printJobs'],
    qrUrl: string,
  ): Promise<CrateDetail> {
    const crate = await this.findOfSite(code, siteId);
    const [facts, events] = await Promise.all([
      this.eventFacts([crate.id]),
      this.prisma.crateEvent.findMany({
        where: { crateId: crate.id },
        include: {
          actor: { select: { displayName: true } },
          location: { select: { code: true, name: true } },
          registration: { select: { code: true } },
          printJob: { select: { code: true } },
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      ...toSummary(crate, facts.get(crate.id)!),
      qrUrl,
      events: events.map((e) => ({
        type: e.type,
        occurredAt: e.occurredAt.toISOString(),
        actor: e.actor.displayName,
        location: e.location,
        registrationCode: e.registration?.code ?? null,
        printJobCode: e.printJob?.code ?? null,
        bottle: payloadText(e.payload, 'bottle'),
        reason: payloadText(e.payload, 'reason'),
      })),
      printJobs,
    };
  }

  /** Public QR resolution: true only for an existing crate token. */
  async existsByToken(token: string): Promise<boolean> {
    return (await this.prisma.crate.count({ where: { qrToken: token } })) > 0;
  }

  /** Latest event time, last recorded location and open cycle per crate (fixed query count). */
  private async eventFacts(crateIds: string[]) {
    const [latest, located, cycles] = await Promise.all([
      this.prisma.crateEvent.findMany({
        where: { crateId: { in: crateIds } },
        distinct: ['crateId'],
        orderBy: [{ crateId: 'asc' }, { occurredAt: 'desc' }, { id: 'desc' }],
        select: { crateId: true, occurredAt: true },
      }),
      this.prisma.crateEvent.findMany({
        where: { crateId: { in: crateIds }, locationId: { not: null } },
        distinct: ['crateId'],
        orderBy: [{ crateId: 'asc' }, { occurredAt: 'desc' }, { id: 'desc' }],
        select: { crateId: true, location: { select: { code: true, name: true } } },
      }),
      this.prisma.crateCycle.findMany({
        where: { crateId: { in: crateIds }, status: { not: 'ABORTED' } },
        select: {
          crateId: true,
          status: true,
          memberCount: true,
          filledCount: true,
          capacity: true,
          product: { select: { code: true, name: true } },
          recipeVersion: { select: { version: true } },
        },
      }),
    ]);
    const locations = new Map(located.map((e) => [e.crateId, e.location]));
    const open = new Map(
      cycles.map(({ crateId, recipeVersion, ...cycle }) => [
        crateId,
        { ...cycle, recipeVersion: recipeVersion.version },
      ]),
    );
    return new Map(
      latest.map((e) => [
        e.crateId,
        {
          lastEventAt: e.occurredAt,
          lastLocation: locations.get(e.crateId) ?? null,
          cycle: open.get(e.crateId) ?? null,
        },
      ]),
    );
  }
}

type CrateFacts = {
  lastEventAt: Date;
  lastLocation: { code: string; name: string } | null;
  cycle: CrateSummary['cycle'];
};

/** A text field of an event payload, or null. */
function payloadText(payload: unknown, key: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : null;
}

function toSummary(c: CrateRecord, facts: CrateFacts): CrateSummary {
  return {
    code: c.code,
    crateType: { code: c.crateType.code, name: c.crateType.name, capacity: c.crateType.capacity },
    status: c.status,
    site: c.site,
    registrationCode: c.registration.code,
    lastLocation: facts.lastLocation,
    cycle: facts.cycle,
    lastEventAt: facts.lastEventAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
  };
}

export type { CrateRecord };
