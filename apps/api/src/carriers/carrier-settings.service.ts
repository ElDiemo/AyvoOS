import type {
  PplSettings,
  PplSettingsInput,
  UpdatePplSettingsRequest,
  VerifyCarrierRequest,
  VerifyCarrierResult,
} from '@ayvo/types';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CarrierRegistryService } from './carrier-registry.service.js';
import { carrierProblems, isVerifiedProduct } from './carrier-settings.rules.js';
import { PplAuthError } from './ppl/ppl-client.js';
import { CarrierCredentialsService } from './carrier-credentials.service.js';
import { isPplConnection } from './ppl/ppl-connections.js';

const DEFAULT_INPUT: PplSettingsInput = {
  enabled: false,
  connection: null,
  sender: {
    name: null,
    street: null,
    city: null,
    postalCode: null,
    country: null,
    contact: null,
    phone: null,
    email: null,
  },
  productCode: null,
  // One PDF label per parcel; the complete A4 document only when explicitly chosen.
  label: { layout: 'SINGLE' },
};

/** The audited, non-secret view of what changed (field names and their new values). */
function changes(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(after)) {
    const old = before?.[k] ?? null;
    if (JSON.stringify(old) !== JSON.stringify(v)) out[k] = v as string | number | boolean | null;
  }
  return out;
}

/**
 * Carrier settings of a site (doc 029 §9): PPL only. ADMIN (`sites:carrier_manage`) views, changes
 * and verifies them; every change and verification is audited (without any secret). The settings
 * name a server-side connection; credentials are never read, shown or stored here. "Ověřit
 * připojení" obtains a token and reads PPL's product code list — it creates no shipment and orders
 * no pickup.
 */
@Injectable()
export class CarrierSettingsService {
  private readonly log = new Logger(CarrierSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
    private readonly registry: CarrierRegistryService,
    private readonly credentials: CarrierCredentialsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async view(siteId: string): Promise<PplSettings> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, code: true, name: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    const row = await this.prisma.siteCarrierSetting.findUnique({
      where: { siteId },
      include: {
        verifier: { select: { displayName: true } },
        updater: { select: { displayName: true } },
      },
    });
    const input: PplSettingsInput = row
      ? {
          enabled: row.enabled,
          connection: row.connection,
          sender: {
            name: row.senderName,
            street: row.senderStreet,
            city: row.senderCity,
            postalCode: row.senderPostalCode,
            country: row.senderCountry,
            contact: row.senderContact,
            phone: row.senderPhone,
            email: row.senderEmail,
          },
          productCode: row.productCode,
          label: { layout: row.labelLayout as 'SINGLE' | 'A4' },
        }
      : DEFAULT_INPUT;
    return {
      ...input,
      site,
      carrier: 'PPL',
      saved: !!row,
      connections: await this.credentials.connections(),
      verified:
        row?.verifiedAt && row.verifiedConnection
          ? {
              at: row.verifiedAt.toISOString(),
              by: row.verifier?.displayName ?? '',
              connection: row.verifiedConnection,
              products: Array.isArray(row.verifiedProducts)
                ? (row.verifiedProducts as { code: string; name: string }[])
                : [],
            }
          : null,
      problems: carrierProblems(
        row,
        row?.connection ? await this.credentials.state(row.connection) : null,
      ),
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updater.displayName ?? null,
    };
  }

  /** Saves the settings (may be incomplete); a changed connection needs a new verification. */
  async update(
    actorId: string,
    siteId: string,
    input: UpdatePplSettingsRequest,
  ): Promise<PplSettings> {
    const { requestId, ...settings } = input;
    await this.operations.run(
      'CARRIER_SETTINGS_UPDATE',
      requestId,
      { actorId, siteId, ...settings },
      async (tx) => {
        const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true } });
        if (!site) throw new NotFoundException('Site not found');
        if (settings.connection && !isPplConnection(settings.connection)) {
          throw domainError(
            422,
            'UNKNOWN_CONNECTION',
            'This connection does not exist on the server',
          );
        }
        // The site row serializes saves (also the very first one, before a settings row exists).
        await tx.$executeRaw`SELECT 1 FROM "sites" WHERE "id" = ${siteId}::uuid FOR UPDATE`;
        const before = await tx.siteCarrierSetting.findUnique({ where: { siteId } });
        const sameConnection = before?.verifiedConnection === settings.connection;
        if (
          settings.productCode &&
          (!before || !sameConnection || !isVerifiedProduct(before, settings.productCode))
        ) {
          throw domainError(
            422,
            'PRODUCT_NOT_VERIFIED',
            'Choose a product from the list read by "Ověřit připojení" with this connection',
          );
        }
        const data = {
          enabled: settings.enabled,
          connection: settings.connection,
          senderName: settings.sender.name,
          senderStreet: settings.sender.street,
          senderCity: settings.sender.city,
          senderPostalCode: settings.sender.postalCode,
          senderCountry: settings.sender.country,
          senderContact: settings.sender.contact,
          senderPhone: settings.sender.phone,
          senderEmail: settings.sender.email,
          productCode: settings.productCode,
          labelLayout: settings.label.layout,
        };
        const now = new Date();
        const reset =
          before && !sameConnection
            ? {
                verifiedAt: null,
                verifiedBy: null,
                verifiedConnection: null,
                verifiedAccount: null,
                verifiedProducts: Prisma.DbNull,
              }
            : {};
        await tx.siteCarrierSetting.upsert({
          where: { siteId },
          create: { siteId, carrier: 'PPL', ...data, updatedAt: now, updatedBy: actorId },
          update: { ...data, ...reset, updatedAt: now, updatedBy: actorId },
        });
        await this.audit.record(
          {
            type: 'CARRIER_SETTINGS_UPDATED',
            actorUserId: actorId,
            siteId,
            payload: { carrier: 'PPL', changes: changes(before, data) },
          },
          tx,
        );
        return { siteId };
      },
    );
    return this.view(siteId);
  }

  /**
   * "Ověřit připojení": a token and PPL's product list with the site's connection. Read-only at
   * PPL — no shipment, no pickup. The outcome (also a failure) is audited without any secret.
   */
  async verify(
    actorId: string,
    siteId: string,
    input: VerifyCarrierRequest,
  ): Promise<VerifyCarrierResult> {
    const row = await this.prisma.siteCarrierSetting.findUnique({ where: { siteId } });
    if (!row?.connection) {
      throw domainError(409, 'NO_CONNECTION', 'Choose and save a connection first');
    }
    const gateway = await this.registry.ppl(row.connection);
    if (!gateway) {
      throw domainError(
        409,
        'CREDENTIALS_MISSING',
        'The server has no credentials for this connection',
      );
    }
    let products: { code: string; name: string }[] | null = null;
    let error: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.env.CARRIER_CALL_TIMEOUT_SECONDS * 1000,
    );
    try {
      products = await gateway.verify(controller.signal);
    } catch (e) {
      // Secret-free: PPL client errors carry only HTTP status codes.
      this.log.warn(
        `PPL verification of site ${siteId} (${row.connection}) failed: ${(e as Error).message}`,
      );
      error =
        e instanceof PplAuthError
          ? 'PPL odmítlo přihlášení (zkontrolujte přístupové údaje na serveru).'
          : 'PPL není dostupné nebo odpověď nebyla použitelná. Zkuste to později.';
    } finally {
      clearTimeout(timer);
    }
    await this.operations.run(
      'CARRIER_CONNECTION_VERIFY',
      input.requestId,
      // The outcome is not part of the request: a repeated click with the same id is the same request.
      { actorId, siteId, connection: row.connection },
      async (tx) => {
        if (products) {
          await tx.siteCarrierSetting.update({
            where: { siteId },
            data: {
              verifiedAt: new Date(),
              verifiedBy: actorId,
              verifiedConnection: row.connection,
              // Valid only for this account: replaced credentials of another account need a new check.
              verifiedAccount: gateway.account,
              verifiedProducts: products,
            },
          });
        }
        await this.audit.record(
          {
            type: products ? 'CARRIER_CONNECTION_VERIFIED' : 'CARRIER_CONNECTION_VERIFY_FAILED',
            actorUserId: actorId,
            siteId,
            payload: {
              carrier: 'PPL',
              connection: row.connection,
              ...(products ? { products: products.length } : { error }),
            },
          },
          tx,
        );
        return { siteId };
      },
    );
    return { ok: !!products, error, settings: await this.view(siteId) };
  }
}
