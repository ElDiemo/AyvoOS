import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CarrierChoice, CarrierGateway, CarrierRegistry } from './carrier.js';
import { carrierProblems, settingsSnapshot } from './carrier-settings.rules.js';
import { PplClient } from './ppl/ppl-client.js';
import { isPplConnection, pplConnection } from './ppl/ppl-connections.js';
import { PplGateway } from './ppl/ppl-gateway.js';
import { TEST_CARRIER_SETTINGS, TestCarrier } from './test-carrier.js';

/**
 * The carrier per site (doc 022 §8, doc 029 §9). A NEW request needs the site's PPL settings
 * complete, enabled and verified, and the server's credentials for the connection; an EXISTING
 * request always uses its own recorded connection and environment. One client (and so one cached
 * token) per connection. The fake TestCarrier replaces everything only with CARRIER_PROVIDER=test
 * (refused unless APP_ENV=test).
 */
@Injectable()
export class CarrierRegistryService implements CarrierRegistry {
  private readonly test: TestCarrier | null;
  private readonly gateways = new Map<string, PplGateway>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.test = env.CARRIER_PROVIDER === 'test' ? new TestCarrier() : null;
  }

  ppl(code: string): PplGateway | null {
    if (!isPplConnection(code)) return null;
    const connection = pplConnection(this.env, code);
    if (!connection) return null;
    let gateway = this.gateways.get(code);
    if (!gateway) {
      gateway = new PplGateway(new PplClient(connection));
      this.gateways.set(code, gateway);
    }
    return gateway;
  }

  async forSite(siteId: string): Promise<CarrierChoice> {
    if (this.test) {
      // A carrier without cancellation is never used for a new shipment (doc 029 §4).
      return this.test.rules.canCancel
        ? { gateway: this.test, settings: TEST_CARRIER_SETTINGS }
        : { gateway: null, reason: 'CANCELLATION_UNSUPPORTED' };
    }
    const row = await this.prisma.siteCarrierSetting.findUnique({ where: { siteId } });
    if (!row) return { gateway: null, reason: 'NOT_CONFIGURED' };
    const problems = carrierProblems(this.env, row);
    if (problems.includes('DISABLED')) return { gateway: null, reason: 'DISABLED' };
    if (problems.includes('CREDENTIALS_MISSING'))
      return { gateway: null, reason: 'CREDENTIALS_MISSING' };
    if (problems.length > 0) return { gateway: null, reason: 'INCOMPLETE' };
    return { gateway: this.ppl(row.connection!)!, settings: settingsSnapshot(row) };
  }

  forConnection(ref: {
    carrierCode: string;
    connection: string;
    environment: string;
  }): CarrierGateway | null {
    if (this.test && ref.carrierCode === this.test.code) {
      return ref.connection === this.test.connection && ref.environment === this.test.environment
        ? this.test
        : null;
    }
    if (ref.carrierCode !== 'PPL') return null;
    const gateway = this.ppl(ref.connection);
    // Never another environment than the request's own.
    return gateway && gateway.environment === ref.environment ? gateway : null;
  }
}
