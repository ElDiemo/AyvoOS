import { crateCodeSchema, type CrateContent, type OutsideBottles } from '@ayvo/types';
import { Controller, Get, Param } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { OperationalSite } from '../identity/access.guard.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { CrateContentService } from './crate-content.service.js';

const CRATE_CODE = new ZodValidationPipe(crateCodeSchema);

/** The crate overview (doc 025 A5): read-only, `crates:read`, the active site only. */
@Controller(ADMIN_PREFIX)
export class CrateContentController {
  constructor(private readonly content: CrateContentService) {}

  @RequirePermission('crates:read')
  @Get('crates/:code/content')
  crateContent(
    @Param('code', CRATE_CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<CrateContent> {
    return this.content.content(code, site.siteId);
  }

  @RequirePermission('crates:read')
  @Get('bottles-outside-crates')
  outside(@OperationalSite() site: SiteContext): Promise<OutsideBottles> {
    return this.content.outside(site.siteId);
  }
}
