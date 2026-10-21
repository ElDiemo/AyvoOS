import { describe, expect, it } from 'vitest';
import { isPlannedRole, PLANNED_SYSTEM_ROLE_CODES, SYSTEM_ROLE_CODES } from './identity.js';

describe('planned system roles (doc 021 §4c)', () => {
  it('are exactly FINANCE and HOTEL_USER (SALES is assignable since Obchod, doc 034)', () => {
    expect([...PLANNED_SYSTEM_ROLE_CODES].sort()).toEqual(['FINANCE', 'HOTEL_USER']);
    for (const code of PLANNED_SYSTEM_ROLE_CODES) expect(SYSTEM_ROLE_CODES).toContain(code);
  });

  it('leaves the active system roles and custom roles assignable', () => {
    for (const code of [
      'ADMIN',
      'WAREHOUSE_OPERATOR',
      'WAREHOUSE_SUPERVISOR',
      'PRODUCTION_OPERATOR',
      'PRODUCTION_SUPERVISOR',
      'SALES',
      'E2E_PRICES',
      'SALES_TEAM',
    ])
      expect(isPlannedRole(code), code).toBe(false);
    for (const code of PLANNED_SYSTEM_ROLE_CODES) expect(isPlannedRole(code)).toBe(true);
  });
});
