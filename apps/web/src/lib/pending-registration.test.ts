import { describe, expect, it } from 'vitest';
import {
  clearPendingRegistration,
  loadPendingRegistration,
  parsePendingRegistration,
  savePendingRegistration,
  subscribePendingRegistration,
} from './pending-registration';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const pending = {
  requestId: '0b7c8f2e-3a51-4c8e-9d7a-2f1e6b5c4d3a',
  labelTemplateVersionId: '01a12ab6-9e94-7363-a22a-15cfb460bc9b',
  quantity: 20,
};

describe('pending registration', () => {
  it('round-trips and clears', () => {
    const store = memoryStore();
    expect(loadPendingRegistration(store)).toBeNull();
    savePendingRegistration(pending, store);
    expect(loadPendingRegistration(store)).toEqual(pending);
    clearPendingRegistration(store);
    expect(loadPendingRegistration(store)).toBeNull();
  });

  it('ignores corrupt or incomplete entries', () => {
    const store = memoryStore();
    store.setItem('ayvo.pendingBottleRegistration', '{not json');
    expect(loadPendingRegistration(store)).toBeNull();
    store.setItem('ayvo.pendingBottleRegistration', JSON.stringify({ requestId: 'x' }));
    expect(loadPendingRegistration(store)).toBeNull();
  });

  it('works without storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => savePendingRegistration(pending, broken)).not.toThrow();
    expect(loadPendingRegistration(broken)).toBeNull();
    expect(() => clearPendingRegistration(broken)).not.toThrow();
    expect(loadPendingRegistration(null)).toBeNull();
  });

  it('notifies subscribers on save and clear', () => {
    const store = memoryStore();
    let calls = 0;
    const unsubscribe = subscribePendingRegistration(() => calls++);
    savePendingRegistration(pending, store);
    clearPendingRegistration(store);
    unsubscribe();
    savePendingRegistration(pending, store);
    expect(calls).toBe(2);
  });

  it('parses raw snapshots', () => {
    expect(parsePendingRegistration(JSON.stringify(pending))).toEqual(pending);
    expect(parsePendingRegistration(null)).toBeNull();
  });
});
