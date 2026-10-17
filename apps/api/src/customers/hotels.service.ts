import type {
  CreateHotelRequest,
  FulfillmentSiteOption,
  HotelDetail,
  HotelSummary,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const hotelInclude = {
  fulfillmentSite: { select: { code: true, name: true } },
  creator: { select: { displayName: true } },
} satisfies Prisma.HotelInclude;
type HotelRecord = Prisma.HotelGetPayload<{ include: typeof hotelInclude }>;

/** Hotels whose fulfilment site may serve them: active, with a warehouse (doc 028 §2). */
const servingSite = { active: true, capabilities: { has: 'WAREHOUSE' } } as const;

/**
 * customers module (doc 007, doc 028): hotels with one delivery address and contact and their
 * fulfilment site — chosen explicitly, never derived from the country (doc 022 §7). Hotels are
 * company-wide master data; their orders belong to the orders module.
 */
@Injectable()
export class HotelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
  ) {}

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
      createdBy: row.creator.displayName,
    };
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
        const site = await tx.site.findFirst({
          where: { id: input.fulfillmentSiteId, ...servingSite },
          select: { id: true },
        });
        if (!site) {
          throw domainError(
            422,
            'FULFILLMENT_SITE_INVALID',
            'The fulfilment site must be an active site with a warehouse',
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
  byCode(code: string, db: Prisma.TransactionClient = this.prisma): Promise<HotelRecord | null> {
    const serial = parseCodeSerial(CODE_PREFIX.hotel, code);
    if (serial === null) return Promise.resolve(null);
    return db.hotel.findUnique({ where: { serial }, include: hotelInclude });
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
