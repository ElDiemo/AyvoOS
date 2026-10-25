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
  financePrincipalRequestSchema,
  financeSupplierLookupSchema,
  type FinanceContractSupplier,
  type FinanceContractSupplierDocument,
  type FinancePrincipal,
  type FinancePrincipalRequest,
  type PermissionCode,
} from '@ayvo/types';
import { z } from 'zod';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { ServiceAccess } from '../identity/access.decorators.js';
import { CurrentPrincipal, forbidden, sameOriginRequest } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
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
}
