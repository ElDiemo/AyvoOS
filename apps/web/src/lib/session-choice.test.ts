import { describe, expect, it } from 'vitest';
import { activeLot, activeSeries } from './session-choice';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('session choices of a label-application session', () => {
  it('parses only complete entries', () => {
    expect(activeLot.parse(JSON.stringify({ id: 'a', code: 'GR-000001/1' }))).toEqual({
      id: 'a',
      code: 'GR-000001/1',
    });
    expect(activeLot.parse(null)).toBeNull();
    expect(activeLot.parse('{broken')).toBeNull();
    expect(activeLot.parse(JSON.stringify({ id: 'a' }))).toBeNull();
    expect(activeSeries.parse(JSON.stringify({ code: 'BC-000001', label: 'mydlo1 v1' }))).toEqual({
      code: 'BC-000001',
      label: 'mydlo1 v1',
    });
    expect(activeSeries.parse(JSON.stringify({ code: 'BC-000001' }))).toBeNull();
  });

  it('changes only through set, notifying subscribers', () => {
    const store = memoryStore();
    let calls = 0;
    const unsubscribe = activeLot.subscribe(() => calls++);
    activeLot.set({ id: 'a', code: 'L1' }, store);
    expect(activeLot.parse(store.data.get(activeLot.key) ?? null)).toEqual({ id: 'a', code: 'L1' });
    activeLot.set(null, store);
    expect(store.data.size).toBe(0);
    unsubscribe();
    expect(calls).toBe(2);
  });

  it('keeps lot and series independent', () => {
    const store = memoryStore();
    activeLot.set({ id: 'a', code: 'L1' }, store);
    activeSeries.set({ code: 'BC-000002', label: 'x' }, store);
    activeSeries.set(null, store);
    expect([...store.data.keys()]).toEqual([activeLot.key]);
  });
});
