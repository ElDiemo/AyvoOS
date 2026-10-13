import {
  activateRecipeRequestSchema,
  archiveRecipeRequestSchema,
  createComponentRequestSchema,
  createCrateTypeRequestSchema,
  createProductRequestSchema,
  createRecipeDraftRequestSchema,
  materialRequirementsQuerySchema,
  productCodeSchema,
  recipeVersionNumberSchema,
  updateRecipeDraftRequestSchema,
  type ActivateRecipeRequest,
  type ArchiveRecipeRequest,
  type CatalogComponent,
  type CrateType,
  type CreateComponentRequest,
  type CreateCrateTypeRequest,
  type CreateProductRequest,
  type CreateRecipeDraftRequest,
  type MaterialRequirements,
  type Product,
  type ProductCategory,
  type RecipeVersion,
  type UpdateRecipeDraftRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CrateTypesService } from '../crates/crate-types.service.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { CatalogService } from './catalog.service.js';
import { RecipesService } from './recipes.service.js';

const PRODUCT = new ZodValidationPipe(productCodeSchema);
const VERSION = new ZodValidationPipe(recipeVersionNumberSchema);

/**
 * The company-wide product catalogue API (doc 023 §7): reading needs `catalog:read`; creating
 * components, crate types, products and recipe drafts needs `catalog:manage`; activating and
 * archiving recipe versions needs `catalog:recipes_activate`. Every change carries a request id
 * (idempotency) and a reason (audit). No route reads or writes stock.
 */
@Controller(`${ADMIN_PREFIX}/catalog`)
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly recipes: RecipesService,
    private readonly crateTypes: CrateTypesService,
  ) {}

  @RequirePermission('catalog:read')
  @Get('categories')
  categories(): Promise<ProductCategory[]> {
    return this.catalog.categories();
  }

  @RequirePermission('catalog:read')
  @Get('components')
  components(): Promise<CatalogComponent[]> {
    return this.catalog.components();
  }

  @RequirePermission('catalog:manage')
  @Post('components')
  createComponent(
    @Body(new ZodValidationPipe(createComponentRequestSchema)) body: CreateComponentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CatalogComponent> {
    return this.catalog.createComponent(principal.userId, body);
  }

  @RequirePermission('catalog:read')
  @Get('crate-types')
  crateTypeList(): Promise<CrateType[]> {
    return this.crateTypes.list();
  }

  @RequirePermission('catalog:manage')
  @Post('crate-types')
  createCrateType(
    @Body(new ZodValidationPipe(createCrateTypeRequestSchema)) body: CreateCrateTypeRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CrateType> {
    return this.crateTypes.create(principal.userId, body);
  }

  @RequirePermission('catalog:read')
  @Get('products')
  products(): Promise<Product[]> {
    return this.catalog.products();
  }

  @RequirePermission('catalog:manage')
  @Post('products')
  createProduct(
    @Body(new ZodValidationPipe(createProductRequestSchema)) body: CreateProductRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Product> {
    return this.catalog.createProduct(principal.userId, body);
  }

  @RequirePermission('catalog:read')
  @Get('products/:code')
  product(@Param('code', PRODUCT) code: string): Promise<Product> {
    return this.catalog.product(code);
  }

  @RequirePermission('catalog:manage')
  @Post('products/:code/recipes')
  createDraft(
    @Param('code', PRODUCT) code: string,
    @Body(new ZodValidationPipe(createRecipeDraftRequestSchema)) body: CreateRecipeDraftRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecipeVersion> {
    return this.recipes.createDraft(principal.userId, code, body);
  }

  @RequirePermission('catalog:read')
  @Get('products/:code/recipes/:version')
  recipe(
    @Param('code', PRODUCT) code: string,
    @Param('version', VERSION) version: number,
  ): Promise<RecipeVersion> {
    return this.recipes.get(code, version);
  }

  @RequirePermission('catalog:manage')
  @Put('products/:code/recipes/:version')
  updateDraft(
    @Param('code', PRODUCT) code: string,
    @Param('version', VERSION) version: number,
    @Body(new ZodValidationPipe(updateRecipeDraftRequestSchema)) body: UpdateRecipeDraftRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecipeVersion> {
    return this.recipes.updateDraft(principal.userId, code, version, body);
  }

  @RequirePermission('catalog:recipes_activate')
  @Post('products/:code/recipes/:version/activate')
  @HttpCode(200)
  activate(
    @Param('code', PRODUCT) code: string,
    @Param('version', VERSION) version: number,
    @Body(new ZodValidationPipe(activateRecipeRequestSchema)) body: ActivateRecipeRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecipeVersion> {
    return this.recipes.activate(principal.userId, code, version, body);
  }

  @RequirePermission('catalog:recipes_activate')
  @Post('products/:code/recipes/:version/archive')
  @HttpCode(200)
  archive(
    @Param('code', PRODUCT) code: string,
    @Param('version', VERSION) version: number,
    @Body(new ZodValidationPipe(archiveRecipeRequestSchema)) body: ArchiveRecipeRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecipeVersion> {
    return this.recipes.archive(principal.userId, code, version, body);
  }

  /** Read-only calculation: reserves and consumes nothing. */
  @RequirePermission('catalog:read')
  @Get('products/:code/recipes/:version/requirements')
  requirements(
    @Param('code', PRODUCT) code: string,
    @Param('version', VERSION) version: number,
    @Query(new ZodValidationPipe(materialRequirementsQuerySchema))
    query: z.infer<typeof materialRequirementsQuerySchema>,
  ): Promise<MaterialRequirements> {
    return this.recipes.requirements(code, version, query.bottles);
  }
}
