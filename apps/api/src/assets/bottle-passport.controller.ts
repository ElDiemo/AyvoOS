import type { PublicBottlePassport } from '@ayvo/types';
import { Controller, Get, Header, Param } from '@nestjs/common';
import { PUBLIC_PREFIX } from '../common/routes.js';
import { BottlesService } from './bottles.service.js';

/**
 * Public bottle passport, resolved by the opaque QR token only. Anonymous, read-only and
 * whitelisted (doc 011). Kept in its own `/api/public` route family so rate limiting and a future
 * public QR host can target exactly these routes (doc 012).
 */
@Controller(`${PUBLIC_PREFIX}/bottles`)
export class BottlePassportController {
  constructor(private readonly bottles: BottlesService) {}

  @Get(':token')
  @Header('Cache-Control', 'public, max-age=60')
  get(@Param('token') token: string): Promise<PublicBottlePassport> {
    return this.bottles.getPassport(token);
  }
}
