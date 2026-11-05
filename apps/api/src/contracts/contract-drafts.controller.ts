import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  contractDraftCodeSchema,
  createContractDraftSchema,
  hotelCodeSchema,
  linkContractHotelSchema,
  prospectCodeSchema,
  removeContractDraftSchema,
  reviseContractDraftSchema,
  type ContractDraftDetail,
  type ContractDraftPrefill,
  type ContractDraftSummary,
  type CreateContractDraftRequest,
  type LinkContractHotelRequest,
  type RemoveContractDraftRequest,
  type ReviseContractDraftRequest,
} from '@ayvo/types';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { ContractDraftsService } from './contract-drafts.service.js';

const CODE = new ZodValidationPipe(contractDraftCodeSchema);
const CONTEXT = new ZodValidationPipe(
  z.strictObject({
    prospect: prospectCodeSchema.optional(),
    hotel: hotelCodeSchema.optional(),
  }),
);

/**
 * Contract drafts (ADR 0043, doc 045). Every route needs `sales:work`; which draft the caller sees
 * or changes is decided in the service on every call — the prospect through Obchod's scope, hotels
 * with sales:manage + hotels:read. Nothing is created by itself.
 */
@Controller(`${ADMIN_PREFIX}/contracts/drafts`)
export class ContractDraftsController {
  constructor(private readonly drafts: ContractDraftsService) {}

  @RequirePermission('sales:work')
  @Get('prefill')
  prefill(
    @Query(CONTEXT) q: { prospect?: string; hotel?: string },
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftPrefill> {
    return this.drafts.prefill(p, q);
  }

  @RequirePermission('sales:work')
  @Get()
  list(
    @Query(CONTEXT) q: { prospect?: string; hotel?: string },
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftSummary[]> {
    return this.drafts.list(p, q);
  }

  @RequirePermission('sales:work')
  @Post()
  create(
    @Body(new ZodValidationPipe(createContractDraftSchema)) body: CreateContractDraftRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftDetail> {
    return this.drafts.create(body, p);
  }

  @RequirePermission('sales:work')
  @Get(':code')
  detail(
    @Param('code', CODE) code: string,
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftDetail> {
    return this.drafts.detail(code, p);
  }

  @RequirePermission('sales:work')
  @Post(':code/revisions')
  revise(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(reviseContractDraftSchema)) body: ReviseContractDraftRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftDetail> {
    return this.drafts.revise(code, body, p);
  }

  @RequirePermission('sales:work')
  @Post(':code/remove')
  @HttpCode(200)
  remove(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(removeContractDraftSchema)) body: RemoveContractDraftRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftDetail> {
    return this.drafts.remove(code, body, p);
  }

  @RequirePermission('sales:work')
  @Post(':code/restore')
  @HttpCode(200)
  restore(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(removeContractDraftSchema)) body: RemoveContractDraftRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftDetail> {
    return this.drafts.restore(code, body, p);
  }

  @RequirePermission('sales:work')
  @Post(':code/hotel')
  @HttpCode(200)
  linkHotel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(linkContractHotelSchema)) body: LinkContractHotelRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ContractDraftDetail> {
    return this.drafts.linkHotel(code, body, p);
  }

  @RequirePermission('sales:work')
  @Get(':code/revisions/:revision/pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(
    @Param('code', CODE) code: string,
    @Param('revision', ParseIntPipe) revision: number,
    @CurrentPrincipal() p: Principal,
  ): Promise<StreamableFile> {
    const { file, name } = await this.drafts.pdf(code, revision, p);
    return new StreamableFile(file, {
      type: 'application/pdf',
      disposition: `attachment; filename="${name}"`,
    });
  }
}
