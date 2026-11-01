import { paymentsPageResponseSchema, paymentsPageSchema } from '@ayvo/types';
import { describe, expect, it } from 'vitest';

/** The answer of Finance at b060802: all payments, no paging fields. */
const oldFinance = { simulationAvailable: true, payments: [] as unknown[] };

describe('new web, older Finance (rollout or return to an earlier image)', () => {
  it('the strict contract of the new Finance refuses it, the schema the web reads takes it', () => {
    expect(paymentsPageSchema.safeParse(oldFinance).success).toBe(false);
    expect(paymentsPageResponseSchema.parse(oldFinance)).toMatchObject({
      legacy: true,
      total: 0,
      page: 1,
      simulationAvailable: true,
    });
  });
  it('the new Finance stays what it says, not legacy', () => {
    expect(
      paymentsPageResponseSchema.parse({ ...oldFinance, total: 40, page: 2, pageSize: 25 }),
    ).toMatchObject({ legacy: false, total: 40, page: 2, pageSize: 25 });
  });
});
