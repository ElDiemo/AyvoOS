import { describe, expect, it } from 'vitest';
import { isPlannedRole, PLANNED_SYSTEM_ROLE_CODES, SYSTEM_ROLE_CODES } from './identity.js';

describe('planned system roles (doc 021 §4c)', () => {
  it('are exactly SALES, FINANCE and HOTEL_USER, all of them system roles', () => {
    expect([...PLANNED_SYSTEM_ROLE_CODES].sort()).toEqual(['FINANCE', 'HOTEL_USER', 'SALES']);
    for (const code of PLANNED_SYSTEM_ROLE_CODES) expect(SYSTEM_ROLE_CODES).toContain(code);
  });

  it('leaves the active system roles and custom roles assignable', () => {
    for (const code of [
      'ADMIN',
      'WAREHOUSE_OPERATOR',
      'WAREHOUSE_SUPERVISOR',
      'PRODUCTION_OPERATOR',
      'PRODUCTION_SUPERVISOR',
      'E2E_PRICES',
      'SALES_TEAM',
    ])
      expect(isPlannedRole(code), code).toBe(false);
    for (const code of PLANNED_SYSTEM_ROLE_CODES) expect(isPlannedRole(code)).toBe(true);
  });
});
