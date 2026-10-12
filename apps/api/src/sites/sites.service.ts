import type {
  CreateSiteRequest,
  CreateSiteWarehouseRequest,
  Site,
  SiteCapability,
  SiteDependency,
  SiteDetail,
  UpdateSiteRequest,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, idempotencyConflict } from '../common/domain-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type Site as SiteRecord } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';

const notFound = () => domainError(404, 'SITE_NOT_FOUND', 'No such site');
const warehouseCodeTaken = () =>
  domainError(409, 'WAREHOUSE_CODE_EXISTS', 'Warehouse codes are unique across all sites');

export type SiteWithWarehouses = SiteRecord & {
  locations: { id: string; code: string; name: string; isSiteDefault: boolean }[];
};

const withWarehouses = {
  locations: {
    select: { id: true, code: true, name: true, isSiteDefault: true },
    orderBy: { code: 'asc' },
  },
} satisfies Prisma.SiteInclude;

/**
 * Sites — AYVO's physical facilities, the top-level operational boundary (doc 022, ADR 0023).
 * Created and edited by ADMIN (`sites:manage`) with a reason and an audit event; never deleted.
 * Deactivation keeps all history and is refused while it would break an operational invariant.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  /** Every site with its warehouses (access evaluation, administration). */
  all(): Promise<SiteWithWarehouses[]> {
    return this.prisma.site.findMany({ include: withWarehouses, orderBy: { code: 'asc' } });
  }

  async list(): Promise<Site[]> {
    return (await this.all()).map(toDto);
  }

  async detail(id: string): Promise<SiteDetail> {
    const site = await this.prisma.site.findUnique({ where: { id }, include: withWarehouses });
    if (!site) throw notFound();
    return {
      ...toDto(site),
      deactivationBlockers: site.active ? await this.deactivationBlockers(site) : [],
      audit: await this.audit.list({ siteId: id }),
    };
  }

  async create(actorId: string, input: CreateSiteRequest): Promise<SiteDetail> {
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.site.findUnique({ where: { code: input.code } })) {
        throw domainError(409, 'SITE_EXISTS', 'A site with this code already exists');
      }
      const site = await tx.site.create({
        data: { ...fields(input), code: input.code, createdBy: actorId, updatedBy: actorId },
      });
      await this.audit.record(
        {
          type: 'SITE_CREATED',
          actorUserId: actorId,
          siteId: site.id,
          reason: input.reason,
          payload: { site: site.code, capabilities: input.capabilities },
        },
        tx,
      );
      return site.id;
    });
    return this.detail(id);
  }

  async update(actorId: string, id: string, input: UpdateSiteRequest): Promise<SiteDetail> {
    await this.prisma.$transaction(async (tx) => {
      const site = await this.lock(tx, id);
      if (
        site.capabilities.includes('WAREHOUSE') &&
        !input.capabilities.includes('WAREHOUSE') &&
        (await this.inventory.listLocations(tx, [id])).length > 0
      ) {
        throw domainError(
          409,
          'SITE_HAS_WAREHOUSES',
          'A site with warehouses keeps the WAREHOUSE capability',
        );
      }
      const changed = Object.entries(fields(input))
        .filter(([key, value]) => {
          const before = (site as unknown as Record<string, unknown>)[key];
          return JSON.stringify(before ?? null) !== JSON.stringify(value ?? null);
        })
        .map(([key]) => key);
      await tx.site.update({
        where: { id },
        data: { ...fields(input), updatedBy: actorId, updatedAt: new Date() },
      });
      await this.audit.record(
        {
          type: 'SITE_UPDATED',
          actorUserId: actorId,
          siteId: id,
          reason: input.reason,
          payload: { site: site.code, changed },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  async deactivate(actorId: string, id: string, reason: string): Promise<SiteDetail> {
    await this.prisma.$transaction(async (tx) => {
      const site = await this.lock(tx, id);
      if (!site.active) throw domainError(409, 'SITE_ALREADY_INACTIVE', 'The site is inactive');
      const blockers = await this.deactivationBlockers(site, tx);
      if (blockers.length > 0) {
        throw domainError(
          409,
          'SITE_DEPENDENCIES',
          blockers.map((b) => `${b.code}: ${b.detail}`).join('; '),
        );
      }
      await tx.site.update({
        where: { id },
        data: {
          active: false,
          deactivatedAt: new Date(),
          updatedBy: actorId,
          updatedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          type: 'SITE_DEACTIVATED',
          actorUserId: actorId,
          siteId: id,
          reason,
          payload: { site: site.code },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  async reactivate(actorId: string, id: string, reason: string): Promise<SiteDetail> {
    await this.prisma.$transaction(async (tx) => {
      const site = await this.lock(tx, id);
      if (site.active) throw domainError(409, 'SITE_ALREADY_ACTIVE', 'The site is active');
      await tx.site.update({
        where: { id },
        data: { active: true, deactivatedAt: null, updatedBy: actorId, updatedAt: new Date() },
      });
      await this.audit.record(
        {
          type: 'SITE_REACTIVATED',
          actorUserId: actorId,
          siteId: id,
          reason,
          payload: { site: site.code },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /**
   * Creates the warehouse of a site (v0.1: exactly one per site, always the default; doc 022 §2).
   * Refused unless the site is active, has the WAREHOUSE capability and no warehouse yet; the code
   * is globally unique. The site lock (all sites, the same lock as every site change) serialises
   * concurrent attempts, so two requests can never create two warehouses for one site. Creation and
   * the audit event (reason, request id) commit together. Idempotency is per site: the same
   * request id at the same site returns the first result (same code, name and reason) or
   * IDEMPOTENCY_CONFLICT (other data); at another site it is an independent operation. No stock, lots,
   * receipts or movements are created; the site's capabilities, users and roles stay unchanged.
   */
  async createWarehouse(
    actorId: string,
    siteId: string,
    input: CreateSiteWarehouseRequest,
  ): Promise<SiteDetail> {
    await this.prisma.$transaction(async (tx) => {
      const site = await this.lock(tx, siteId);
      // The request id lives in the append-only audit event of the creation (no separate request
      // table for site administration) and is scoped to the site: the same id at another site is
      // an independent operation. Checked under the lock, so it is race-free.
      const previous = await tx.auditEvent.findFirst({
        where: {
          type: 'WAREHOUSE_CREATED',
          siteId,
          payload: { path: ['requestId'], equals: input.requestId },
        },
      });
      if (previous) {
        const p = previous.payload as Record<string, unknown>;
        const same =
          p.warehouse === input.code && p.name === input.name && previous.reason === input.reason;
        if (same) return;
        throw idempotencyConflict();
      }
      if (!site.active) {
        throw domainError(
          409,
          'SITE_INACTIVE',
          'The site is inactive: its history can be read, not changed',
        );
      }
      if (!site.capabilities.includes('WAREHOUSE')) {
        throw domainError(
          409,
          'SITE_NOT_WAREHOUSE',
          'Only a site with the WAREHOUSE capability has a warehouse',
        );
      }
      if ((await this.inventory.listLocations(tx, [siteId])).length > 0) {
        throw domainError(409, 'SITE_HAS_WAREHOUSE', 'The site already has its warehouse');
      }
      if (await this.inventory.locationByCode(input.code, tx)) {
        throw warehouseCodeTaken();
      }
      try {
        await this.inventory.createSiteWarehouse(tx, {
          siteId,
          code: input.code,
          name: input.name,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw warehouseCodeTaken();
        }
        throw error;
      }
      await this.audit.record(
        {
          type: 'WAREHOUSE_CREATED',
          actorUserId: actorId,
          siteId,
          reason: input.reason,
          payload: {
            site: site.code,
            warehouse: input.code,
            name: input.name,
            default: true,
            requestId: input.requestId,
          },
        },
        tx,
      );
    });
    return this.detail(siteId);
  }

  /**
   * What prevents deactivation now. v0.1: stock still held at the site's warehouses, and the
   * last active site. Future modules add theirs here (active hotels served by the site, open
   * production orders, crates in circulation, carrier accounts — doc 022 §6).
   */
  private async deactivationBlockers(
    site: SiteRecord,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<SiteDependency[]> {
    const blockers: SiteDependency[] = [];
    if (await this.inventory.siteHasStock(site.id)) {
      blockers.push({
        code: 'STOCK_ON_HAND',
        detail: 'The site’s warehouses still hold stock',
      });
    }
    const otherActive = await db.site.count({ where: { active: true, id: { not: site.id } } });
    if (otherActive === 0) {
      blockers.push({ code: 'LAST_ACTIVE_SITE', detail: 'At least one site must stay active' });
    }
    return blockers;
  }

  private async lock(tx: Prisma.TransactionClient, id: string): Promise<SiteRecord> {
    // Serialises concurrent changes of one site (and the "last active site" check).
    await tx.$queryRaw`SELECT 1 FROM "sites" FOR UPDATE`;
    const site = await tx.site.findUnique({ where: { id } });
    if (!site) throw notFound();
    return site;
  }
}

function fields(input: UpdateSiteRequest) {
  return {
    name: input.name,
    countryCode: input.countryCode,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    postalCode: input.postalCode,
    city: input.city,
    timeZone: input.timeZone,
    defaultLocale: input.defaultLocale,
    defaultCurrency: input.defaultCurrency,
    capabilities: [...input.capabilities] as SiteCapability[],
  };
}

export function toDto(site: SiteWithWarehouses): Site {
  return {
    id: site.id,
    code: site.code,
    name: site.name,
    countryCode: site.countryCode,
    addressLine1: site.addressLine1,
    addressLine2: site.addressLine2,
    postalCode: site.postalCode,
    city: site.city,
    addressComplete: site.addressLine1 !== null,
    timeZone: site.timeZone,
    defaultLocale: site.defaultLocale,
    defaultCurrency: site.defaultCurrency,
    capabilities: site.capabilities,
    active: site.active,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
    deactivatedAt: site.deactivatedAt?.toISOString() ?? null,
    warehouses: site.locations.map((l) => ({
      code: l.code,
      name: l.name,
      default: l.isSiteDefault,
    })),
  };
}
