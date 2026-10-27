import { describe, expect, it } from 'vitest';
import {
  createRoleRequestSchema,
  currentUserSchema,
  isPermissionCode,
  isPlannedRole,
  PERMISSION_CODES,
  PERMISSION_MODULES,
  permissionCatalogSchema,
  PLANNED_SYSTEM_ROLE_CODES,
  SYSTEM_ROLE_CODES,
} from './identity.js';

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

describe('permission modules', () => {
  it('every permission belongs to a known module (the role pages group by it)', () => {
    for (const code of PERMISSION_CODES)
      expect(PERMISSION_MODULES, code).toContain(code.split(':')[0]);
  });
});

describe('permissions reported by a newer database (rollback compatibility)', () => {
  const me = (permissions: string[]) => ({
    user: { id: '01990000-0000-7000-8000-000000000001', email: 'a@b.test', displayName: 'A' },
    roles: [{ code: 'ADMIN', name: 'Admin' }],
    permissions,
    scopes: [],
    sites: [],
    activeSiteId: null,
    globalSiteAccess: true,
    session: {
      idleExpiresAt: new Date().toISOString(),
      absoluteExpiresAt: new Date().toISOString(),
    },
  });

  it('an unknown code does not break the signed-in user and grants nothing', () => {
    const parsed = currentUserSchema.parse(me(['finance:documents_read', 'future:feature_x']));
    expect(parsed.permissions).toEqual(['finance:documents_read']);
    expect(isPermissionCode('future:feature_x')).toBe(false);
  });

  it('the permission catalogue leaves unknown entries out but stays strict for the known ones', () => {
    const entry = (code: string, module = code.split(':')[0]) => ({
      code,
      description: 'x',
      module,
      warehouseScoped: false,
      securityAdmin: false,
    });
    expect(
      permissionCatalogSchema
        .parse([entry('inventory:read'), entry('future:feature_x')])
        .map((p) => p.code),
    ).toEqual(['inventory:read']);
    // A known code with a broken entry is still an error (nothing hidden).
    expect(permissionCatalogSchema.safeParse([entry('inventory:read', 'nonsense')]).success).toBe(
      false,
    );
  });

  it('requests stay strict: an unknown code is never sent or accepted', () => {
    expect(
      createRoleRequestSchema.safeParse({
        code: 'CUSTOM_X',
        name: 'x',
        description: '',
        permissions: ['future:feature_x'],
        reason: 'test důvodu',
      }).success,
    ).toBe(false);
  });
});
