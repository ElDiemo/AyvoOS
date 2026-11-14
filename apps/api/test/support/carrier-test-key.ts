/**
 * The CARRIER_CREDENTIALS_KEY of the test files that use the simulated PPL (ppl.e2e, ppl-pickups).
 * They share one test database, where administration credentials of PPL_TEST may remain from an
 * earlier file (rows are replaced, never deleted): one synthetic key lets every such file read them.
 * A test-only value — never a key of any environment.
 */
export const CARRIER_TEST_KEY = Buffer.alloc(32, 0x5a).toString('base64');

/** The synthetic PPL account those files simulate (also left as PPL_TEST's admin credentials). */
export const PPL_TEST_ACCOUNT = { id: 'ayvo-test-client', secret: 'ayvo-test-secret-value' };
