import {
  catalogCodeSchema,
  productCodeSchema,
  recordDimensionsRequestSchema,
  recordItemWeightRequestSchema,
  recordProductWeightRequestSchema,
  recordTareRequestSchema,
  type CrateTypeMeasurements,
  type ItemWeights,
  type ProductWeights,
  type RecordDimensionsRequest,
  type RecordItemWeightRequest,
  type RecordProductWeightRequest,
  type RecordTareRequest,
} from '@ayvo/types';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { WeightsService } from './weights.service.js';

const CODE = new ZodValidationPipe(catalogCodeSchema);
const PRODUCT = new ZodValidationPipe(productCodeSchema);

/**
 * Weights and dimensions in the catalogue (doc 025 §10, PR W1): read with catalog:read,
 * recorded with catalog:weights_record (production supervisor, warehouse supervisor, ADMIN).
 */
@Controller(`${ADMIN_PREFIX}/catalog`)
export class WeightsController {
  constructor(private readonly weights: WeightsService) {}

  @RequirePermission('catalog:read')
  @Get('components/:code/weights')
  itemWeights(@Param('code', CODE) code: string): Promise<ItemWeights> {
    return this.weights.itemWeights(code);
  }

  @RequirePermission('catalog:weights_record')
  @Post('components/:code/weights')
  recordItemWeight(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(recordItemWeightRequestSchema)) body: RecordItemWeightRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ItemWeights> {
    return this.weights.recordItemWeight(principal.userId, code, body);
  }

  @RequirePermission('catalog:read')
  @Get('products/:code/weights')
  productWeights(@Param('code', PRODUCT) code: string): Promise<ProductWeights> {
    return this.weights.productWeights(code);
  }

  @RequirePermission('catalog:weights_record')
  @Post('products/:code/weights')
  recordProductWeight(
    @Param('code', PRODUCT) code: string,
    @Body(new ZodValidationPipe(recordProductWeightRequestSchema))
    body: RecordProductWeightRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProductWeights> {
    return this.weights.recordProductWeight(principal.userId, code, body);
  }

  @RequirePermission('catalog:read')
  @Get('crate-types/:code/measurements')
  crateTypeMeasurements(@Param('code', CODE) code: string): Promise<CrateTypeMeasurements> {
    return this.weights.crateTypeMeasurements(code);
  }

  @RequirePermission('catalog:weights_record')
  @Post('crate-types/:code/tare')
  recordTare(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(recordTareRequestSchema)) body: RecordTareRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CrateTypeMeasurements> {
    return this.weights.recordTare(principal.userId, code, body);
  }

  @RequirePermission('catalog:weights_record')
  @Post('crate-types/:code/dimensions')
  recordDimensions(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(recordDimensionsRequestSchema)) body: RecordDimensionsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CrateTypeMeasurements> {
    return this.weights.recordDimensions(principal.userId, code, body);
  }
}
