import {
  employeeCardActionSchema,
  employeeCardSlugSchema,
  saveEmployeeCardSchema,
  type EmployeeCardAction,
  type SaveEmployeeCard,
} from '@ayvo/types';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Public, RequirePermission } from './access.decorators.js';
import { CurrentPrincipal } from './access.guard.js';
import type { Principal } from './principal.js';
import { EmployeeCardsService } from './employee-cards.service.js';
import { CARD_PHOTO_MAX_BYTES } from './employee-card-photo.js';
import { EmployeeCardRateLimit } from './employee-card-rate-limit.service.js';
import { employeeCardVcard } from './employee-card-vcard.js';

const actor = (p: Principal) => ({ userId: p.userId, permissions: p.permissions });

@Controller('admin/identity/users/:userId/business-card')
export class EmployeeCardsController {
  constructor(private readonly cards: EmployeeCardsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @RequirePermission('identity:users_manage')
  get(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.cards.get(userId);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  save(
    @CurrentPrincipal() p: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(saveEmployeeCardSchema)) body: SaveEmployeeCard,
  ) {
    return this.cards.save(actor(p), userId, body);
  }

  @Post('publish')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  publish(
    @CurrentPrincipal() p: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(employeeCardActionSchema)) body: EmployeeCardAction,
  ) {
    return this.cards.publish(actor(p), userId, body);
  }

  @Post('hide')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  hide(
    @CurrentPrincipal() p: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(employeeCardActionSchema)) body: EmployeeCardAction,
  ) {
    return this.cards.hide(actor(p), userId, body);
  }

  @Post('photos')
  @RequirePermission('identity:users_manage')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: CARD_PHOTO_MAX_BYTES, files: 1, fields: 1 } }),
  )
  upload(
    @CurrentPrincipal() p: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body('requestId', new ZodValidationPipe(z.uuid())) requestId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.cards.upload(actor(p), userId, requestId, file?.buffer ?? Buffer.alloc(0));
  }

  @Get('photos/:photoId')
  @RequirePermission('identity:users_manage')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ) {
    return new StreamableFile(await this.cards.photo(userId, photoId), { type: 'image/png' });
  }
}

/** Only publication-by-slug, never a directory, authenticated DTO or draft preview endpoint. */
@Controller('public/employee-cards')
export class PublicEmployeeCardsController {
  constructor(
    private readonly cards: EmployeeCardsService,
    private readonly limit: EmployeeCardRateLimit,
  ) {}

  @Get(':slug')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async get(
    @Req() req: IncomingMessage,
    @Param('slug', new ZodValidationPipe(employeeCardSlugSchema)) slug: string,
  ) {
    await this.limit.check(req);
    return this.cards.publicCard(slug);
  }

  @Get(':slug/contact.vcf')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async vcard(
    @Req() req: IncomingMessage,
    @Param('slug', new ZodValidationPipe(employeeCardSlugSchema)) slug: string,
  ) {
    await this.limit.check(req);
    return new StreamableFile(Buffer.from(employeeCardVcard(await this.cards.publicCard(slug))), {
      type: 'text/vcard; charset=utf-8',
      disposition: `attachment; filename="${slug}.vcf"`,
    });
  }

  @Get(':slug/photo')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(
    @Req() req: IncomingMessage,
    @Param('slug', new ZodValidationPipe(employeeCardSlugSchema)) slug: string,
    @Query('version', new ZodValidationPipe(z.coerce.number().int().positive())) version: number,
  ) {
    await this.limit.check(req);
    return new StreamableFile(await this.cards.publicPhoto(slug, version), { type: 'image/png' });
  }
}
