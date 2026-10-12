import type { AdminUserDetail, AssignableSites, RoleCatalog } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import {
  accessChanges,
  blockingReason,
  draftFromUser,
  setNarrowed,
  toggleRole,
  toggleSite,
  toggleWarehouse,
} from './access-draft';

const CZ = '01990000-0000-7000-8000-000000000001';
const DE = '01990000-0000-7000-8000-000000000002';
const sites: AssignableSites = [
  {
    id: CZ,
    code: 'CZ-PREROV-01',
    name: 'Přerov 1',
    active: true,
    warehouses: [{ code: 'MAIN', name: 'Hlavní sklad' }],
  },
  {
    id: DE,
    code: 'DE-TEST-01',
    name: 'Německo',
    active: true,
    warehouses: [
      { code: 'DE-A', name: 'Sklad A' },
      { code: 'DE-B', name: 'Sklad B' },
    ],
  },
];
const role = (code: string, name: string) =>
  ({ code, name, system: true, active: true, permissions: [] }) as unknown as RoleCatalog[number];
const roles: RoleCatalog = [
  role('WAREHOUSE_OPERATOR', 'Skladník'),
  role('WAREHOUSE_SUPERVISOR', 'Vedoucí skladu'),
];
const user = {
  roles: [{ code: 'WAREHOUSE_OPERATOR', name: 'Skladník' }],
  scopes: [
    { type: 'SITE', siteId: DE, siteCode: 'DE-TEST-01', locationCode: null },
    { type: 'WAREHOUSE', siteId: null, siteCode: null, locationCode: 'DE-A' },
  ],
} as unknown as AdminUserDetail;

describe('access editor draft', () => {
  const start = draftFromUser(user, sites);

  it('starts from the current assignments, marking narrowed sites', () => {
    expect(start).toEqual({
      roles: ['WAREHOUSE_OPERATOR'],
      siteIds: [DE],
      narrowed: [DE],
      warehouseCodes: ['DE-A'],
    });
  });

  it('summarises what is added and removed, in human names', () => {
    let d = toggleRole(start, 'WAREHOUSE_SUPERVISOR');
    d = toggleRole(d, 'WAREHOUSE_OPERATOR');
    d = toggleSite(d, sites[0]!);
    d = toggleWarehouse(d, 'DE-B');
    const c = accessChanges(start, d, roles, sites);
    expect(c).toEqual({
      added: {
        roles: ['Vedoucí skladu'],
        sites: ['Přerov 1 (CZ-PREROV-01)'],
        warehouses: ['Sklad B (DE-B) – Německo'],
      },
      removed: { roles: ['Skladník'], sites: [], warehouses: [] },
      empty: false,
    });
  });

  it('removing a site removes its narrowing and warehouses too', () => {
    const d = toggleSite(start, sites[1]!);
    expect(d).toEqual({
      roles: ['WAREHOUSE_OPERATOR'],
      siteIds: [],
      narrowed: [],
      warehouseCodes: [],
    });
    expect(accessChanges(start, d, roles, sites).removed).toEqual({
      roles: [],
      sites: ['Německo (DE-TEST-01)'],
      warehouses: ['Sklad A (DE-A) – Německo'],
    });
  });

  it('"all warehouses" drops the chosen ones', () => {
    const d = setNarrowed(start, sites[1]!, false);
    expect(d.narrowed).toEqual([]);
    expect(d.warehouseCodes).toEqual([]);
  });

  it('explains every blocker next to the button; the reason only once saving is attempted', () => {
    const none = accessChanges(start, start, roles, sites);
    expect(blockingReason(none, start, sites, '', true)).toBe('Nejsou žádné změny k uložení.');

    const noWarehouse = toggleWarehouse(start, 'DE-A');
    expect(
      blockingReason(
        accessChanges(start, noWarehouse, roles, sites),
        noWarehouse,
        sites,
        'x',
        false,
      ),
    ).toBe('Vyberte alespoň jeden sklad (Německo), nebo zvolte všechny sklady provozovny.');

    const changed = toggleRole(start, 'WAREHOUSE_SUPERVISOR');
    const c = accessChanges(start, changed, roles, sites);
    expect(blockingReason(c, changed, sites, '', false)).toBeNull();
    expect(blockingReason(c, changed, sites, ' a ', true)).toBe(
      'Vyplňte důvod změny (alespoň 3 znaky).',
    );
    expect(blockingReason(c, changed, sites, 'povýšení', true)).toBeNull();
  });
});
