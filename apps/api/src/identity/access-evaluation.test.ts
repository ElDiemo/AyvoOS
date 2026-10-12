import type { PermissionCode } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import type { SiteWithWarehouses } from '../sites/sites.service.js';
import { evaluateSites } from './access.service.js';
import { assertCanGrant } from './users.service.js';

const site = (id: string, locations: string[], active = true) =>
  ({
    id,
    code: id.toUpperCase(),
    name: id,
    countryCode: 'CZ',
    timeZone: 'Europe/Prague',
    active,
    capabilities: ['WAREHOUSE'],
    locations: locations.map((l, i) => ({
      id: l,
      code: l.toUpperCase(),
      name: l,
      isSiteDefault: i === 0,
    })),
  }) as unknown as SiteWithWarehouses;

const SITES = [site('cz', ['cz-main', 'cz-b']), site('de', ['de-main'])];

describe('site and warehouse evaluation (doc 022)', () => {
  it('global access means every site and warehouse, without scope rows', () => {
    const access = evaluateSites(SITES, true, []);
    expect(access.map((s) => s.id)).toEqual(['cz', 'de']);
    expect(access.every((s) => s.allWarehouses)).toBe(true);
  });

  it('a site scope opens all its warehouses; warehouse scopes narrow it', () => {
    const all = evaluateSites(SITES, false, [{ type: 'SITE', siteId: 'cz', locationId: null }]);
    expect(all.map((s) => [s.id, [...s.warehouseIds]])).toEqual([['cz', ['cz-main', 'cz-b']]]);
    const narrow = evaluateSites(SITES, false, [
      { type: 'SITE', siteId: 'cz', locationId: null },
      { type: 'WAREHOUSE', siteId: null, locationId: 'cz-b' },
    ]);
    expect(narrow[0]).toMatchObject({ allWarehouses: false, warehouses: [{ code: 'CZ-B' }] });
  });

  it('a warehouse scope without its site grants nothing', () => {
    expect(
      evaluateSites(SITES, false, [{ type: 'WAREHOUSE', siteId: null, locationId: 'de-main' }]),
    ).toEqual([]);
    expect(evaluateSites(SITES, false, [])).toEqual([]);
  });
});

describe('no privilege escalation', () => {
  const actor = (permissions: PermissionCode[]) => ({
    userId: 'u',
    permissions: new Set(permissions),
  });

  it('grants only permissions the actor holds', () => {
    expect(() => assertCanGrant(actor(['inventory:read']), ['inventory:read'])).not.toThrow();
    expect(() =>
      assertCanGrant(actor(['inventory:read']), ['inventory:read', 'procurement:cost_read']),
    ).toThrow(/procurement:cost_read/);
  });
});
