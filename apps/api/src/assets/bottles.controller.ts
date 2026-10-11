import {
  bottleCodeSchema,
  bottleCreationBatchCodeSchema,
  bottleListQuerySchema,
  type BottleCreationBatch,
  type BottleCreationBatchListResponse,
  type BottleDetail,
  type BottleListQuery,
  type BottleListResponse,
} from '@ayvo/types';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BottlesService } from './bottles.service.js';

const batchListQuerySchema = bottleListQuerySchema.pick({ page: true, pageSize: true });

/** Admin read API for bottles and creation batches (creation: label-production module). */
@Controller(ADMIN_PREFIX)
export class BottlesController {
  constructor(private readonly bottles: BottlesService) {}

  @Get('bottles')
  list(
    @Query(new ZodValidationPipe(bottleListQuerySchema)) query: BottleListQuery,
  ): Promise<BottleListResponse> {
    return this.bottles.list(query);
  }

  @Get('bottles/:code')
  get(@Param('code', new ZodValidationPipe(bottleCodeSchema)) code: string): Promise<BottleDetail> {
    return this.bottles.getByCode(code);
  }

  @Get('bottle-batches')
  listBatches(
    @Query(new ZodValidationPipe(batchListQuerySchema)) query: z.infer<typeof batchListQuerySchema>,
  ): Promise<BottleCreationBatchListResponse> {
    return this.bottles.listBatches(query.page, query.pageSize);
  }

  @Get('bottle-batches/:code')
  getBatch(
    @Param('code', new ZodValidationPipe(bottleCreationBatchCodeSchema)) code: string,
  ): Promise<BottleCreationBatch> {
    return this.bottles.getBatchByCode(code);
  }
}
