import { describe, expect, it } from 'vitest';
import { parseActiveLot, setActiveLot, subscribeActiveLot } from './active-lot';

describe('active lot of a label-application session', () => {
  it('parses only complete entries', () => {
    expect(parseActiveLot(JSON.stringify({ id: 'a', code: 'GR-000001/1' }))).toEqual({
      id: 'a',
      code: 'GR-000001/1',
    });
    expect(parseActiveLot(null)).toBeNull();
    expect(parseActiveLot('{broken')).toBeNull();
    expect(parseActiveLot(JSON.stringify({ id: 'a' }))).toBeNull();
  });

  it('changes only through setActiveLot, notifying subscribers', () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    let calls = 0;
    const unsubscribe = subscribeActiveLot(() => calls++);
    setActiveLot({ id: 'a', code: 'L1' }, store);
    expect(parseActiveLot(data.get('ayvo.warehouse.activeLot') ?? null)).toEqual({
      id: 'a',
      code: 'L1',
    });
    setActiveLot(null, store);
    expect(data.size).toBe(0);
    unsubscribe();
    expect(calls).toBe(2);
  });
});
