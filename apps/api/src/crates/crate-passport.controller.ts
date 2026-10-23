import type { PublicCrate } from '@ayvo/types';
import { Controller, Get, Header, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { PublicRateLimitGuard } from '../common/public-rate-limit.guard.js';
import { PUBLIC_PREFIX } from '../common/routes.js';
import { Public } from '../identity/access.decorators.js';
import { CratesService } from './crates.service.js';

/**
 * Public page of a crate QR token (doc 020 §3.4): only that this is a returnable AYVO crate —
 * never its code, site, location, hotel, order, contents, count or history.
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller(`${PUBLIC_PREFIX}/crates`)
export class CratePassportController {
  constructor(private readonly crates: CratesService) {}

  @Get(':token')
  @Header('Cache-Control', 'public, max-age=60')
  async get(@Param('token') token: string): Promise<PublicCrate> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(token) || !(await this.crates.existsByToken(token))) {
      throw new NotFoundException('Not found');
    }
    return { kind: 'AYVO_RETURNABLE_CRATE' };
  }
}
