import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CarrierChoice, CarrierGateway, CarrierRef, CarrierRegistry } from './carrier.js';
import { CarrierCredentialsService } from './carrier-credentials.service.js';
import { carrierProblems, settingsSnapshot } from './carrier-settings.rules.js';
import { PplClient } from './ppl/ppl-client.js';
import { isPplConnection, pplBaseUrl } from './ppl/ppl-connections.js';
import { PplGateway } from './ppl/ppl-gateway.js';
import { TEST_CARRIER_SETTINGS, TestCarrier } from './test-carrier.js';

/**
 * The carrier per site (doc 022 §8, doc 029 §9, ADR 0027). A NEW request needs the site's PPL
 * settings complete, enabled and verified with the current account, and usable credentials; an
 * EXISTING request always uses its own recorded connection, environment AND account — replaced
 * credentials of another account never take over an existing shipment. One client (one cached
 * token) per connection and credential version. The fake TestCarrier replaces everything only with
 * CARRIER_PROVIDER=test (refused unless APP_ENV=test).
 */
@Injectable()
export class CarrierRegistryService implements CarrierRegistry {
  private readonly test: TestCarrier | null;
  private readonly gateways = new Map<string, { version: string; gateway: PplGateway }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CarrierCredentialsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.test = env.CARRIER_PROVIDER === 'test' ? new TestCarrier() : null;
  }

  /** The PPL gateway with the connection's CURRENT credentials, or null. */
  async ppl(code: string): Promise<PplGateway | null> {
    if (!isPplConnection(code)) return null;
    const creds = await this.credentials.resolve(code);
    if (!creds) return null;
    const cached = this.gateways.get(code);
    if (cached?.version === `${creds.version}:${creds.account}`) return cached.gateway;
    const gateway = new PplGateway(
      new PplClient({
        code,
        environment: creds.environment,
        baseUrl: pplBaseUrl(this.env, code),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      }),
      creds.account,
    );
    this.gateways.set(code, { version: `${creds.version}:${creds.account}`, gateway });
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
    const state = row.connection ? await this.credentials.state(row.connection) : null;
    const problems = carrierProblems(row, state);
    if (problems.includes('DISABLED')) return { gateway: null, reason: 'DISABLED' };
    if (problems.includes('CREDENTIALS_MISSING') || problems.includes('CREDENTIALS_UNREADABLE'))
      return { gateway: null, reason: 'CREDENTIALS_MISSING' };
    if (problems.length > 0) return { gateway: null, reason: 'INCOMPLETE' };
    const gateway = await this.ppl(row.connection!);
    // The account checked by the rules must still be the one in use (no change in between).
    if (!gateway || gateway.account !== state?.account) {
      return { gateway: null, reason: 'INCOMPLETE' };
    }
    return { gateway, settings: settingsSnapshot(row) };
  }

  async forConnection(ref: CarrierRef): Promise<CarrierGateway | null> {
    if (this.test && ref.carrierCode === this.test.code) {
      return ref.connection === this.test.connection &&
        ref.environment === this.test.environment &&
        ref.account === this.test.account
        ? this.test
        : null;
    }
    if (ref.carrierCode !== 'PPL') return null;
    const gateway = await this.ppl(ref.connection);
    // Never another environment or another account than the request's own.
    return gateway && gateway.environment === ref.environment && gateway.account === ref.account
      ? gateway
      : null;
  }
}
