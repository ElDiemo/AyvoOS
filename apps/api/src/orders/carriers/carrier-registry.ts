import type { Env } from '../../config/env.js';
import type { CarrierRegistry } from './carrier.js';
import { TEST_CARRIER_SETTINGS, TestCarrier } from './test-carrier.js';

/**
 * The carrier per site (doc 022 §8). Without a configured carrier no new request is possible
 * (NOT_CONFIGURED, shown truthfully). The fake TestCarrier exists only with CARRIER_PROVIDER=test,
 * which the environment schema allows only with APP_ENV=test.
 */
export function carrierRegistry(env: Env): CarrierRegistry {
  const test = env.CARRIER_PROVIDER === 'test' ? new TestCarrier() : null;
  return {
    forSite: async () =>
      test
        ? { gateway: test, settings: TEST_CARRIER_SETTINGS }
        : { gateway: null, reason: 'NOT_CONFIGURED' },
    forConnection: (ref) =>
      test &&
      ref.carrierCode === test.code &&
      ref.connection === test.connection &&
      ref.environment === test.environment
        ? test
        : null,
  };
}
