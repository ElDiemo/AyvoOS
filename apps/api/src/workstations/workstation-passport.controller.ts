import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { PUBLIC_PREFIX } from '../common/routes.js';
import { QrRegistryService } from '../database/qr-registry.service.js';
import { Public } from '../identity/access.decorators.js';

/**
 * Public page of a station QR token (doc 026): only "an internal AYVO mark" — never the station,
 * site, mode, users or anything about the work there.
 */
@Public()
@Controller(`${PUBLIC_PREFIX}/workstations`)
export class WorkstationPassportController {
  constructor(private readonly registry: QrRegistryService) {}

  @Get(':token')
  @Header('Cache-Control', 'public, max-age=60')
  async get(@Param('token') token: string): Promise<{ kind: 'AYVO_INTERNAL_MARK' }> {
    const known =
      /^[A-Za-z0-9_-]{22}$/.test(token) && (await this.registry.kindOf(token)) === 'WORKSTATION';
    if (!known) throw new NotFoundException('Not found');
    return { kind: 'AYVO_INTERNAL_MARK' };
  }
}
