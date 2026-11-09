import { createHash } from 'node:crypto';
import type {
  FinanceContractHotel,
  CreateHotelRequest,
  FulfillmentSiteOption,
  HotelDetail,
  HotelProfileFields,
  HotelSummary,
  PortalHotelProfile,
  UpdateHotelPracticalRequest,
} from '@ayvo/types';
import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { lockSiteShared, SiteDependencyRegistry } from '../sites/site-dependencies.js';

const hotelInclude = {
  fulfillmentSite: { select: { code: true, name: true } },
  creator: { select: { displayName: true } },
} satisfies Prisma.HotelInclude;
type HotelRecord = Prisma.HotelGetPayload<{ include: typeof hotelInclude }>;

/**
 * Sites that may serve a hotel: active, with the WAREHOUSE capability AND a really created
 * warehouse (owner 2026-10-17 — the capability alone is not enough).
 */
const servingSite = {
  active: true,
  capabilities: { has: 'WAREHOUSE' },
  locations: { some: {} },
} satisfies Prisma.SiteWhereInput;

/**
 * customers module (doc 007, doc 028): hotels with one delivery address and contact and their
 * fulfilment site — chosen explicitly, never derived from the country (doc 022 §7). Hotels are
 * company-wide master data; their orders belong to the orders module.
 */
@Injectable()
export class HotelsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
    private readonly siteDependencies: SiteDependencyRegistry,
  ) {}

  /** A site serving hotels stays active (doc 022 §7; no hotel reassignment exists yet). */
  onModuleInit(): void {
    this.siteDependencies.register(async (siteId, db) => {
      const n = await db.hotel.count({ where: { fulfillmentSiteId: siteId } });
      return n > 0
        ? [{ code: 'HOTELS_SERVED', detail: `${n} hotel(s) are served by this site` }]
        : [];
    });
  }

  /** All hotels, or those served by one site (ordering at the active site). */
  async list(fulfillmentSiteId?: string): Promise<HotelSummary[]> {
    const rows = await this.prisma.hotel.findMany({
      where: fulfillmentSiteId ? { fulfillmentSiteId } : {},
      include: hotelInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map(toSummary);
  }

  async detail(code: string): Promise<HotelDetail> {
    const row = await this.byCode(code);
    if (!row) throw new NotFoundException('Hotel not found');
    return {
      ...toSummary(row),
      address: {
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2,
        postalCode: row.postalCode,
        city: row.city,
        countryCode: row.countryCode,
      },
      contact: { name: row.contactName, phone: row.contactPhone, email: row.contactEmail },
      practical: {
        deliveryNote: row.deliveryNote,
        receivingContact: row.receivingContactName
          ? {
              name: row.receivingContactName,
              phone: row.receivingContactPhone,
              email: row.receivingContactEmail,
            }
          : null,
      },
      id: row.id,
      createdBy: row.creator.displayName,
    };
  }

  /**
   * The optional practical details (doc 032): delivery note and receiving contact. Never required
   * of existing hotels; the address, main contact and serving site are not changed here. Reason
   * and before/after audited. Orders keep their own snapshot.
   */
  async updatePractical(
    actorId: string,
    code: string,
    input: UpdateHotelPracticalRequest,
  ): Promise<HotelDetail> {
    await this.operations.run(
      'HOTEL_UPDATE',
      input.requestId,
      { actorId, code, ...input, requestId: undefined },
      async (tx) => {
        const row = await this.byCode(code, tx);
        if (!row) throw new NotFoundException('Hotel not found');
        await tx.$executeRaw`SELECT 1 FROM "hotels" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
        const before = {
          deliveryNote: row.deliveryNote,
          receivingContactName: row.receivingContactName,
          receivingContactPhone: row.receivingContactPhone,
          receivingContactEmail: row.receivingContactEmail,
        };
        const after = {
          deliveryNote: input.deliveryNote,
          receivingContactName: input.receivingContactName,
          receivingContactPhone: input.receivingContactPhone,
          receivingContactEmail: input.receivingContactEmail,
        };
        await tx.hotel.update({ where: { id: row.id }, data: after });
        await this.audit.record(
          {
            type: 'HOTEL_UPDATED',
            actorUserId: actorId,
            siteId: row.fulfillmentSiteId,
            payload: { hotel: row.code, reason: input.reason, before, after },
          },
          tx,
        );
        return { code: row.code };
      },
    );
    return this.detail(code);
  }

  /**
   * A hotel's own profile for the hotel portal (portal "Profil hotelu"), read through the caller's
   * client. Access (the session's active grant on this hotel) is the portal contract's business;
   * this owns only what the profile is. Null for an unknown id.
   */
  async portalProfile(
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<PortalHotelProfile | null> {
    const row = await db.hotel.findUnique({ where: { id }, select: profileSelect });
    return row ? toPortalProfile(row) : null;
  }

  /**
   * Saves a hotel's own profile from the hotel portal, inside the caller's transaction (which has
   * already re-checked the session and its grant on this hotel under the account's lock). Only the
   * whitelisted fields change; the name, country, code, id and serving site never do. The row is
   * locked; a save made against older values (another fingerprint) is refused, unless it asks for
   * exactly what is stored (a repeated save: nothing changes, nothing is audited). Orders keep
   * their own snapshot, so the change applies to orders created afterwards. Audited as
   * HOTEL_UPDATED with the portal account, its grant, the hotel's reason and before/after.
   */
  async applyPortalProfile(
    tx: Prisma.TransactionClient,
    input: {
      hotelId: string;
      actorUserId: string;
      grantId: string;
      expected: string;
      profile: HotelProfileFields;
      reason: string;
    },
  ): Promise<PortalHotelProfile> {
    await tx.$executeRaw`SELECT 1 FROM "hotels" WHERE "id" = ${input.hotelId}::uuid FOR UPDATE`;
    const row = await tx.hotel.findUnique({ where: { id: input.hotelId }, select: profileSelect });
    if (!row) throw domainError(404, 'HOTEL_NOT_FOUND', 'No such hotel');
    const before = profileFields(row);
    const after = { ...input.profile };
    if (sameProfile(before, after)) return toPortalProfile(row);
    if (fingerprintOf(row.id, before) !== input.expected)
      throw domainError(
        409,
        'PROFILE_STALE',
        'Údaje hotelu se mezitím změnily. Načtěte je znovu a upravte znovu.',
      );
    const updated = await tx.hotel.update({
      where: { id: row.id },
      data: after,
      select: profileSelect,
    });
    const changed = (Object.keys(after) as (keyof HotelProfileFields)[]).filter(
      (k) => before[k] !== after[k],
    );
    await this.audit.record(
      {
        type: 'HOTEL_UPDATED',
        actorUserId: input.actorUserId,
        siteId: row.fulfillmentSiteId,
        reason: input.reason,
        payload: {
          hotel: row.code,
          via: 'PORTAL',
          grantId: input.grantId,
          changed,
          before: pick(before, changed),
          after: pick(after, changed),
        },
      },
      tx,
    );
    return toPortalProfile(updated);
  }

  fulfillmentSites(): Promise<FulfillmentSiteOption[]> {
    return this.prisma.site.findMany({
      where: servingSite,
      select: { id: true, code: true, name: true, countryCode: true },
      orderBy: { code: 'asc' },
    });
  }

  async create(actorId: string, input: CreateHotelRequest): Promise<HotelDetail> {
    const { result } = await this.operations.run(
      'HOTEL_CREATE',
      input.requestId,
      { actorId, ...input, requestId: undefined },
      async (tx) => {
        // Serialised with a deactivation of that site (its lock): never served by a site that
        // is being deactivated on a stale check.
        await lockSiteShared(tx, input.fulfillmentSiteId);
        const site = await tx.site.findFirst({
          where: { id: input.fulfillmentSiteId, ...servingSite },
          select: { id: true },
        });
        if (!site) {
          throw domainError(
            422,
            'FULFILLMENT_SITE_INVALID',
            'The fulfilment site must be an active site with a created warehouse',
          );
        }
        const { first: serial } = await allocateSerials(tx, 'hotel', 1);
        const hotel = await tx.hotel.create({
          data: {
            serial,
            code: formatCode(CODE_PREFIX.hotel, serial),
            name: input.name,
            addressLine1: input.addressLine1,
            addressLine2: input.addressLine2,
            postalCode: input.postalCode,
            city: input.city,
            countryCode: input.countryCode,
            contactName: input.contactName,
            contactPhone: input.contactPhone,
            contactEmail: input.contactEmail,
            fulfillmentSiteId: site.id,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        await this.audit.record(
          {
            type: 'HOTEL_CREATED',
            actorUserId: actorId,
            siteId: site.id,
            payload: { hotel: hotel.code, name: hotel.name, country: hotel.countryCode },
          },
          tx,
        );
        return { code: hotel.code };
      },
    );
    return this.detail(result.code);
  }

  /** The hotel by its code (any site), or null. */
  /**
   * Hotels for the Finance contract (ADR 0039 §10, doc 040): identity and address only — no
   * contacts, site or delivery details. All hotels, or those of the given ids (an unknown id is
   * simply absent).
   */
  /** `db`: a caller's own client (the hotel portal reads through its reserved pool). */
  financeContractHotels(
    ids?: readonly string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<FinanceContractHotel[]> {
    return db.hotel.findMany({
      where: ids ? { id: { in: [...ids] } } : undefined,
      orderBy: { serial: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        countryCode: true,
      },
    });
  }

  byCode(code: string, db: Prisma.TransactionClient = this.prisma): Promise<HotelRecord | null> {
    const serial = parseCodeSerial(CODE_PREFIX.hotel, code);
    if (serial === null) return Promise.resolve(null);
    return db.hotel.findUnique({ where: { serial }, include: hotelInclude });
  }

  /** Identity and address of hotels (contract drafts, ADR 0043) — the same narrow view as Finance's. */
  identities(ids?: readonly string[]): Promise<FinanceContractHotel[]> {
    return this.financeContractHotels(ids);
  }

  /** One hotel by its id (for modules that keep a reference to it, e.g. contract drafts). */
  byId(id: string, db: Prisma.TransactionClient = this.prisma): Promise<HotelRecord | null> {
    return db.hotel.findUnique({ where: { id }, include: hotelInclude });
  }
}

function toSummary(row: HotelRecord): HotelSummary {
  return {
    code: row.code,
    name: row.name,
    city: row.city,
    countryCode: row.countryCode,
    fulfillmentSite: row.fulfillmentSite,
    createdAt: row.createdAt.toISOString(),
  };
}

const profileSelect = {
  id: true,
  code: true,
  name: true,
  countryCode: true,
  fulfillmentSiteId: true,
  addressLine1: true,
  addressLine2: true,
  postalCode: true,
  city: true,
  contactName: true,
  contactPhone: true,
  contactEmail: true,
  receivingContactName: true,
  receivingContactPhone: true,
  receivingContactEmail: true,
  deliveryNote: true,
} satisfies Prisma.HotelSelect;
type ProfileRow = Prisma.HotelGetPayload<{ select: typeof profileSelect }>;

/** The editable values, in one fixed order (the fingerprint depends on it). */
const PROFILE_KEYS = [
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'contactName',
  'contactPhone',
  'contactEmail',
  'receivingContactName',
  'receivingContactPhone',
  'receivingContactEmail',
  'deliveryNote',
] as const satisfies readonly (keyof HotelProfileFields)[];

function profileFields(row: ProfileRow): HotelProfileFields {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, row[k]])) as HotelProfileFields;
}

function sameProfile(a: HotelProfileFields, b: HotelProfileFields): boolean {
  return PROFILE_KEYS.every((k) => a[k] === b[k]);
}

function fingerprintOf(id: string, fields: HotelProfileFields): string {
  return createHash('sha256')
    .update(JSON.stringify([id, ...PROFILE_KEYS.map((k) => fields[k])]))
    .digest('hex');
}

function pick(fields: HotelProfileFields, keys: readonly (keyof HotelProfileFields)[]) {
  return Object.fromEntries(keys.map((k) => [k, fields[k]]));
}

function toPortalProfile(row: ProfileRow): PortalHotelProfile {
  return {
    id: row.id,
    name: row.name,
    countryCode: row.countryCode,
    address: {
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      postalCode: row.postalCode,
      city: row.city,
    },
    contact: { name: row.contactName, phone: row.contactPhone, email: row.contactEmail },
    receiving: {
      contactName: row.receivingContactName,
      contactPhone: row.receivingContactPhone,
      contactEmail: row.receivingContactEmail,
      deliveryNote: row.deliveryNote,
    },
    fingerprint: fingerprintOf(row.id, profileFields(row)),
  };
}
