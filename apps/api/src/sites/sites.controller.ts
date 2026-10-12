import {
  createSiteRequestSchema,
  siteStatusRequestSchema,
  updateSiteRequestSchema,
  type CreateSiteRequest,
  type Site,
  type SiteDetail,
  type SiteStatusRequest,
  type UpdateSiteRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { SitesService } from './sites.service.js';

const ID = new ParseUUIDPipe();

/** Site administration (ADMIN, `sites:manage`; doc 022). Every change needs a reason. */
@Controller(`${ADMIN_PREFIX}/sites`)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @RequirePermission('sites:manage')
  list(): Promise<Site[]> {
    return this.sites.list();
  }

  @Post()
  @RequirePermission('sites:manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createSiteRequestSchema)) body: CreateSiteRequest,
  ): Promise<SiteDetail> {
    return this.sites.create(principal.userId, body);
  }

  @Get(':id')
  @RequirePermission('sites:manage')
  detail(@Param('id', ID) id: string): Promise<SiteDetail> {
    return this.sites.detail(id);
  }

  @Post(':id')
  @HttpCode(200)
  @RequirePermission('sites:manage')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(updateSiteRequestSchema)) body: UpdateSiteRequest,
  ): Promise<SiteDetail> {
    return this.sites.update(principal.userId, id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('sites:manage')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(siteStatusRequestSchema)) body: SiteStatusRequest,
  ): Promise<SiteDetail> {
    return this.sites.deactivate(principal.userId, id, body.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('sites:manage')
  reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(siteStatusRequestSchema)) body: SiteStatusRequest,
  ): Promise<SiteDetail> {
    return this.sites.reactivate(principal.userId, id, body.reason);
  }
}
