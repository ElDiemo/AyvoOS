import { describe, expect, it } from 'vitest';
import {
  createSiteWarehouseRequestSchema,
  suggestedWarehouseCode,
  warehouseCodeSchema,
} from './sites.js';

describe('site warehouse codes (globally unique, doc 022)', () => {
  it('suggests <SITE>-MAIN when it fits, never the bare MAIN of the initial site', () => {
    expect(suggestedWarehouseCode('DE-TEST-01')).toBe('DE-TEST-01-MAIN');
    expect(suggestedWarehouseCode('CZ-PREROV-01')).toBe('CZ-PREROV-01-MAIN');
    // 20 characters at most, like the database CHECK.
    expect(suggestedWarehouseCode('ABCDEFGHIJKLMNOP')).toBeNull();
  });

  it('accepts exactly the database pattern', () => {
    for (const ok of ['MAIN', 'DE-TEST-01-MAIN', 'CZ_B2', 'A1'])
      expect(warehouseCodeSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['main', 'M', '1MAIN', 'DE TEST', 'A'.repeat(21), 'DE/1'])
      expect(warehouseCodeSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('requires a request id, a name and a reason', () => {
    const valid = {
      requestId: '01990000-0000-7000-8000-000000000001',
      code: 'DE-TEST-01-MAIN',
      name: ' Hlavní sklad ',
      reason: 'first warehouse',
    };
    expect(createSiteWarehouseRequestSchema.parse(valid).name).toBe('Hlavní sklad');
    for (const change of [{ reason: '  ' }, { name: '' }, { requestId: 'x' }, { code: 'main' }])
      expect(createSiteWarehouseRequestSchema.safeParse({ ...valid, ...change }).success).toBe(
        false,
      );
  });
});
