import {
  bottleCirculationQuerySchema,
  type BottleCirculationList,
  type BottleCirculationQuery,
} from '@ayvo/types';
import { Controller, Get, Query } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { OperationalSite } from '../identity/access.guard.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { BottleCirculationService } from './bottle-circulation.service.js';

/**
 * Výroba → Lahve, the operating view (doc 048 §3.0a, R3-c): read only, the same permission and
 * site scope as the bottle list and detail.
 */
@Controller(ADMIN_PREFIX)
export class BottleCirculationController {
  constructor(private readonly circulation: BottleCirculationService) {}

  @RequirePermission('production:read')
  @Get('bottle-circulation')
  list(
    @Query(new ZodValidationPipe(bottleCirculationQuerySchema)) query: BottleCirculationQuery,
    @OperationalSite() site: SiteContext,
  ): Promise<BottleCirculationList> {
    return this.circulation.ofCodes(query.codes, site);
  }
}
