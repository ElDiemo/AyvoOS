import {
  productionReadinessQuerySchema,
  type ProductionReadiness,
  type ProductionReadinessQuery,
} from '@ayvo/types';
import { Controller, Get, Query } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Authenticated } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { ReadinessService } from './readiness.service.js';

/**
 * "Připravit výrobu" (doc 027 §4). `@Authenticated()`: the service admits ANY of
 * production:workstations_manage / catalog:product_manage and then gates every returned item by
 * its own existing permission and the session's active site and warehouses.
 */
@Controller(`${ADMIN_PREFIX}/production`)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Authenticated()
  @Get('readiness')
  get(
    @Query(new ZodValidationPipe(productionReadinessQuerySchema)) query: ProductionReadinessQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProductionReadiness> {
    return this.readiness.readiness(principal, query);
  }
}
