import { describe, expect, it } from 'vitest';
import { afterWashStorageKey, clearForSiteChange } from './site-storage';

function memory(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    keys: () => [...map.keys()].sort(),
  };
}

describe('clearForSiteChange', () => {
  it('clears every site-dependent state but keeps the unsent "Po mytí" scans of each user and site', () => {
    const mine = afterWashStorageKey('user-a', 'site-1');
    const elsewhere = afterWashStorageKey('user-a', 'site-2');
    const other = afterWashStorageKey('user-b', 'site-1');
    const s = memory({
      [mine]: '[]',
      [elsewhere]: '[]',
      [other]: '[]',
      'ayvo:picking:OBJ-000001': '[]',
      'ayvo:labeling:station': '{}',
      unrelated: 'x',
    });
    clearForSiteChange(s);
    expect(s.keys()).toEqual([mine, elsewhere, other].sort());
  });

  it('names one key per user and site', () => {
    expect(afterWashStorageKey('u', 's')).toBe('ayvo:after-wash:u:s');
    expect(afterWashStorageKey('u', null)).toBe('ayvo:after-wash:u:none');
    expect(afterWashStorageKey('u', 's')).not.toBe(afterWashStorageKey('v', 's'));
  });
});
