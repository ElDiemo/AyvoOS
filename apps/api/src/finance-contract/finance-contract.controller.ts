import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  financeHotelLookupSchema,
  financePrincipalRequestSchema,
  financeSupplierLookupSchema,
  portalAccountRequestSchema,
  portalGrantRequestLookupSchema,
  portalGrantIssueRequestSchema,
  portalGrantReplaceRequestSchema,
  portalInvitationRequestSchema,
  type FinanceContractHotel,
  type FinanceContractSupplier,
  type FinanceContractSupplierDocument,
  type FinancePrincipal,
  type FinancePrincipalRequest,
  type PermissionCode,
  type PortalAccount,
  type PortalGrantRequestLookup,
  type PortalAccountRequest,
  type PortalGrant,
  type PortalGrantListItem,
  type PortalInvitation,
  type PortalInvitationRequest,
  type PortalGrantIssueRequest,
  type PortalGrantReplaceRequest,
} from '@ayvo/types';
import { z } from 'zod';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { ServiceAccess } from '../identity/access.decorators.js';
import { CurrentPrincipal, forbidden, sameOriginRequest } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { HotelsService } from '../customers/hotels.service.js';
import { PortalGrantsService } from '../portal-grants/portal-grants.service.js';
import { ProcurementService } from '../procurement/procurement.service.js';

const require = (p: Principal, ...codes: PermissionCode[]) => {
  if (!codes.every((c) => p.permissions.has(c))) throw forbidden();
};
/** A supplier document is the paperwork of its site: readable where the user reads it (doc 021). */
const readsSite = (p: Principal, siteId: string) =>
  p.permissions.has('procurement:documents_read') &&
  (p.globalSiteAccess || p.sites.some((s) => s.id === siteId));

/**
 * The core's side of the Finance unit's contract (ADR 0039 §4). Every route: the Finance service
 * token AND the user's forwarded session token (AccessGuard, `@ServiceAccess('finance')`); the
 * user's permissions and sites are evaluated now, on every call. Read-only: Finance never writes
 * core data. Not reachable from the browser (Caddy aborts /api/internal/*).
 */
@Controller('internal/v1/finance')
export class FinanceContractController {
  constructor(
    private readonly procurement: ProcurementService,
    private readonly hotels: HotelsService,
    private readonly portalGrants: PortalGrantsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The current user for one Finance request, after the core's CSRF rule on its method/origin. */
  @ServiceAccess('finance')
  @Post('principal')
  @HttpCode(200)
  principal(
    @Body(new ZodValidationPipe(financePrincipalRequestSchema)) body: FinancePrincipalRequest,
    @CurrentPrincipal() p: Principal,
  ): FinancePrincipal {
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(body.method.toUpperCase());
    if (!safe && !sameOriginRequest(body.secFetchSite, body.origin, this.env.APP_PUBLIC_ORIGIN))
      throw domainError(403, 'CSRF_REJECTED', 'Cross-site request refused');
    return {
      userId: p.userId,
      displayName: p.displayName,
      permissions: [...p.permissions].sort(),
      globalSiteAccess: p.globalSiteAccess,
      siteIds: p.sites.map((s) => s.id),
    };
  }

  /** Active suppliers to choose from. */
  @ServiceAccess('finance')
  @Get('suppliers')
  async suppliers(@CurrentPrincipal() p: Principal): Promise<FinanceContractSupplier[]> {
    require(p, 'finance:documents_manage');
    const all = await this.procurement.listSuppliers(false);
    return this.procurement.suppliersByIds(all.map((s) => s.id));
  }

  /** Suppliers by id (also archived ones: history and exports name them). */
  @ServiceAccess('finance')
  @Post('suppliers/lookup')
  @HttpCode(200)
  lookup(
    @Body(new ZodValidationPipe(financeSupplierLookupSchema)) body: { ids: string[] },
    @CurrentPrincipal() p: Principal,
  ): Promise<FinanceContractSupplier[]> {
    require(p, 'finance:documents_read');
    return this.procurement.suppliersByIds(body.ids);
  }

  /** Supplier documents the user may read (their sites), optionally of one supplier. */
  @ServiceAccess('finance')
  @Get('supplier-documents')
  async documents(
    @Query(new ZodValidationPipe(z.object({ supplierId: z.uuid().optional() })))
    query: { supplierId?: string },
    @CurrentPrincipal() p: Principal,
  ): Promise<FinanceContractSupplierDocument[]> {
    require(p, 'finance:documents_manage', 'procurement:documents_read');
    return this.procurement.supplierDocumentsOfSites(
      p.globalSiteAccess ? null : p.sites.map((s) => s.id),
      query.supplierId,
    );
  }

  /** One supplier document; another site's document is "not found" (no IDOR). */
  @ServiceAccess('finance')
  @Get('supplier-documents/:id')
  async document(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ): Promise<FinanceContractSupplierDocument> {
    require(p, 'finance:documents_read');
    const doc = await this.procurement.supplierDocumentById(id);
    if (!doc || !readsSite(p, doc.siteId))
      throw new NotFoundException('Supplier document not found');
    return doc;
  }

  /** Its unchanged bytes — the same check on every call (also for downloads and exports). */
  @ServiceAccess('finance')
  @Get('supplier-documents/:id/content')
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ): Promise<StreamableFile> {
    require(p, 'finance:documents_read');
    const doc = await this.procurement.supplierDocumentById(id);
    if (!doc || !readsSite(p, doc.siteId))
      throw new NotFoundException('Supplier document not found');
    return new StreamableFile(await this.procurement.supplierDocumentBytes(id), {
      type: 'application/octet-stream',
    });
  }

  /** Hotels to bill (doc 040): identity and address only — the hotel stays the core's record. */
  @ServiceAccess('finance')
  @Get('hotels')
  hotelsForBilling(@CurrentPrincipal() p: Principal): Promise<FinanceContractHotel[]> {
    require(p, 'finance:billing_read');
    return this.hotels.financeContractHotels();
  }

  /** Hotels by id (agreements name them); an unknown id is simply absent. */
  @ServiceAccess('finance')
  @Post('hotels/lookup')
  @HttpCode(200)
  hotelLookup(
    @Body(new ZodValidationPipe(financeHotelLookupSchema)) body: { ids: string[] },
    @CurrentPrincipal() p: Principal,
  ): Promise<FinanceContractHotel[]> {
    require(p, 'finance:billing_read');
    return this.hotels.financeContractHotels(body.ids);
  }

  // --- hotel portal grants (ADR 0045 §4) ---------------------------------------------------
  // Finance has checked, in its own transaction, that the hotels belong to the payer; the core
  // re-checks the admin's permissions on the forwarded session, the account (PORTAL, active) and
  // the hotels, and stores the grant. The core never calls Finance.

  /** A new grant for a hotel portal account. */
  @ServiceAccess('finance')
  @Post('portal-grants')
  issuePortalGrant(
    @Body(new ZodValidationPipe(portalGrantIssueRequestSchema)) body: PortalGrantIssueRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalGrant> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.issue(p.userId, body);
  }

  /** The active grant replaced by one with the given hotels (also when narrowed). */
  @ServiceAccess('finance')
  @Post('portal-grants/:id/replace')
  replacePortalGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(portalGrantReplaceRequestSchema)) body: PortalGrantReplaceRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalGrant> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.replace(p.userId, id, body);
  }

  /** The stored result of a grant request already performed (read only; else 404). */
  @ServiceAccess('finance')
  @Post('portal-grants/requests/lookup')
  @HttpCode(200)
  portalGrantRequest(
    @Body(new ZodValidationPipe(portalGrantRequestLookupSchema)) body: PortalGrantRequestLookup,
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalGrant> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.performed(p.userId, body);
  }

  /** The PORTAL account of an e-mail (created when new) — Finance's first step of a new grant. */
  @ServiceAccess('finance')
  @Post('portal-accounts')
  @HttpCode(200)
  portalAccount(
    @Body(new ZodValidationPipe(portalAccountRequestSchema)) body: PortalAccountRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalAccount> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.ensureAccount(p.userId, body);
  }

  /** Finance's last step: the invitation, only once the account holds an active grant. */
  @ServiceAccess('finance')
  @Post('portal-accounts/:id/invitation')
  @HttpCode(200)
  portalInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(portalInvitationRequestSchema)) body: PortalInvitationRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalInvitation> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.invite(p.userId, id, body.requestId);
  }

  /** The payer's grants for its page in Finance ("Přístup do portálu"). */
  @ServiceAccess('finance')
  @Get('portal-grants')
  portalGrantsOfPayer(
    @Query(new ZodValidationPipe(z.object({ payerCustomerId: z.uuid() })))
    query: { payerCustomerId: string },
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalGrantListItem[]> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.ofPayer(query.payerCustomerId);
  }

  /** One grant (Finance re-checks a replacement against the grant's own payer). */
  @ServiceAccess('finance')
  @Get('portal-grants/:id')
  portalGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ): Promise<PortalGrant> {
    require(p, 'finance:billing_read', 'identity:portal_grants_manage');
    return this.portalGrants.byId(id);
  }
}
