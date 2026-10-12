import type { HealthResponse } from '@ayvo/types';
import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';
import { Public } from '../identity/access.decorators.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<HealthResponse> {
    return this.health.check();
  }
}
