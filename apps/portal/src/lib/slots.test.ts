import { describe, expect, it } from 'vitest';
import {
  boundedPassThrough,
  contentLengthWithin,
  deadline,
  KeyedSlotLimit,
  readBounded,
  SlotLimit,
  StartQuota,
  TransferCut,
} from './slots';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Waits until `cond` holds (each macrotask), at most `ms`. */
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(1);
  return cond();
}
/** A cancellation that completes only when the test says so (no timing assumption). */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

/**
 * An upstream body of n chunks that records its cancellation. `cancelMs` makes the cancellation
 * itself take time (as an HTTP body that closes its socket asynchronously).
 */
function upstream(
  chunks: number,
  opts: { delayMs?: number; cancelMs?: number; cancelGate?: Promise<void>; size?: number } = {},
) {
  const state = { cancelling: false, cancelled: false, served: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (opts.delayMs) await tick(opts.delayMs);
        if (state.served >= chunks) return controller.close();
        state.served++;
        controller.enqueue(new Uint8Array(opts.size ?? 1024));
      },
      async cancel() {
        state.cancelling = true;
        if (opts.cancelMs) await tick(opts.cancelMs);
        if (opts.cancelGate) await opts.cancelGate;
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

const never = () => new AbortController().signal;

describe('PDF slots in portal-web (ADR 0045 §8)', () => {
  it('a slot limit refuses at once beyond its size; a release counts once', () => {
    const slots = new SlotLimit(2);
    const a = slots.acquire()!;
    const b = slots.acquire()!;
    expect(slots.acquire()).toBeNull();
    a();
    a();
    expect(slots.inFlight).toBe(1);
    b();
    expect(slots.inFlight).toBe(0);
  });

  it('the slot is held until the browser has pulled the last byte', async () => {
    const slots = new SlotLimit(2);
    const release = slots.acquire()!;
    const up = upstream(5);
    const body = boundedPassThrough(up.body, {
      stop: never(),
      maxBytes: 1 << 20,
      release,
      abortUpstream: () => {},
    });
    const reader = body.getReader();
    await reader.read();
    // Nothing is read ahead for a slow receiver (no buffering in portal-web).
    expect(up.state.served).toBeLessThanOrEqual(2);
    expect(slots.inFlight).toBe(1);
    for (;;) if ((await reader.read()).done) break;
    expect(slots.inFlight).toBe(0);
  });

  it('review 5818694161: with an asynchronous cancel the slot is held until it has finished — three rounds at capacity 2 never pile up cancellations', async () => {
    const slots = new SlotLimit(2);
    const all: ReturnType<typeof upstream>[] = [];
    for (let round = 0; round < 3; round++) {
      const readers = [];
      for (let i = 0; i < 2; i++) {
        const release = slots.acquire();
        expect(release, `round ${round}, transfer ${i}`).not.toBeNull();
        const up = upstream(1000, { cancelMs: 30 });
        all.push(up);
        const reader = boundedPassThrough(up.body, {
          stop: never(),
          maxBytes: 1 << 30,
          release: release!,
          abortUpstream: () => {},
        }).getReader();
        await reader.read();
        readers.push(reader);
      }
      // Both browsers leave; the upstream cancellation takes 30 ms.
      const leaving = readers.map((r) => r.cancel());
      await tick(5);
      // A third request may not overtake the cleanup: the slots are still held.
      expect(slots.inFlight).toBe(2);
      expect(slots.acquire()).toBeNull();
      await Promise.all(leaving);
      expect(slots.inFlight).toBe(0);
      // Nothing is still being torn down once the slots are free.
      expect(all.filter((u) => u.state.cancelling && !u.state.cancelled)).toHaveLength(0);
    }
    expect(all.every((u) => u.state.cancelled)).toBe(true);
  });

  it('the browser going away aborts the upstream and releases only after the cancellation settled', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    const g = gate();
    const up = upstream(1000, { cancelGate: g.opened });
    let aborted = false;
    const reader = boundedPassThrough(up.body, {
      stop: never(),
      maxBytes: 1 << 30,
      release,
      abortUpstream: () => (aborted = true),
    }).getReader();
    await reader.read();
    const leaving = reader.cancel();
    expect(await until(() => up.state.cancelling)).toBe(true);
    // The upstream's cancellation has not settled: the slot is still held.
    expect([slots.inFlight, aborted, up.state.cancelled]).toEqual([1, true, false]);
    g.open();
    await leaving;
    expect([slots.inFlight, up.state.cancelled]).toEqual([0, true]);
  });

  it('one deadline: a receiver that never reads off is cut, the upstream cancelled, then the slot released', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    const g = gate();
    const up = upstream(1000, { cancelGate: g.opened });
    const stop = deadline(50);
    const body = boundedPassThrough(up.body, {
      stop: stop.signal,
      maxBytes: 1 << 30,
      release,
      abortUpstream: () => {},
    });
    // The deadline cuts it: the upstream is being cancelled, the slot still held until it settled.
    expect(await until(() => up.state.cancelling)).toBe(true);
    expect([up.state.cancelled, slots.inFlight]).toEqual([false, 1]);
    g.open();
    expect(await until(() => slots.inFlight === 0)).toBe(true);
    expect(up.state.cancelled).toBe(true);
    await expect(body.getReader().read()).rejects.toMatchObject({ reason: 'DEADLINE' });
  });

  it('a deadline that already passed (e.g. spent on the fetch) cuts the transfer at once', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    const up = upstream(10);
    const stop = new AbortController();
    stop.abort();
    const body = boundedPassThrough(up.body, {
      stop: stop.signal,
      maxBytes: 1 << 30,
      release,
      abortUpstream: () => {},
    });
    await expect(body.getReader().read()).rejects.toBeInstanceOf(TransferCut);
    await tick(1);
    expect([slots.inFlight, up.state.cancelled]).toEqual([0, true]);
  });

  it('more bytes than allowed cut the transfer, whatever the upstream announced', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    const up = upstream(100, { size: 1000 });
    const reader = boundedPassThrough(up.body, {
      stop: never(),
      maxBytes: 2_500,
      release,
      abortUpstream: () => {},
    }).getReader();
    await reader.read();
    await reader.read();
    await expect(reader.read()).rejects.toMatchObject({ reason: 'TOO_LARGE' });
    await tick(1);
    expect([slots.inFlight, up.state.cancelled, up.state.served]).toEqual([0, true, 3]);
  });

  it('an upstream failure mid-transfer releases the slot', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    let n = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ > 1) controller.error(new Error('finance gone'));
        else controller.enqueue(new Uint8Array(10));
      },
    });
    const reader = boundedPassThrough(failing, {
      stop: never(),
      maxBytes: 1 << 20,
      release,
      abortUpstream: () => {},
    }).getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) break;
      })(),
    ).rejects.toMatchObject({ reason: 'UPSTREAM' });
    expect(slots.inFlight).toBe(0);
  });
});

describe('bounded reads', () => {
  it('reads a small body whole', async () => {
    const up = upstream(3, { size: 10 });
    expect((await readBounded(up.body, { maxBytes: 100, stop: never() })).byteLength).toBe(30);
  });

  it('a body beyond the limit is refused while reading (no Content-Length needed), after its cancellation', async () => {
    const up = upstream(1000, { size: 1000, cancelMs: 10 });
    await expect(readBounded(up.body, { maxBytes: 4096, stop: never() })).rejects.toMatchObject({
      reason: 'TOO_LARGE',
    });
    expect([up.state.served, up.state.cancelled]).toEqual([5, true]);
  });

  it('a body that trickles is cut at the deadline', async () => {
    const up = upstream(1000, { size: 1, delayMs: 30 });
    const stop = deadline(80);
    const started = Date.now();
    await expect(readBounded(up.body, { maxBytes: 4096, stop: stop.signal })).rejects.toMatchObject(
      { reason: 'DEADLINE' },
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(up.state.cancelled).toBe(true);
  });

  it('a Content-Length must be a plain number within the limit', () => {
    expect(contentLengthWithin(null, 10)).toBe(true);
    expect(contentLengthWithin('10', 10)).toBe(true);
    expect(contentLengthWithin('11', 10)).toBe(false);
    for (const bad of ['', '-1', '1e3', '0x10', ' 5', '5,5', '99999999999999'])
      expect(contentLengthWithin(bad, 1 << 30), bad).toBe(false);
  });

  it('a deadline is also ended by the signal it follows (the browser leaving)', () => {
    const browser = new AbortController();
    const d = deadline(10_000, browser.signal);
    browser.abort();
    expect(d.signal.aborted).toBe(true);
    expect((d.signal.reason as TransferCut).reason).toBe('CLIENT');
  });
});

describe('KeyedSlotLimit: per key and in total (packages per account, #178 review)', () => {
  it('one per key, the total bounded; a release frees both, once', () => {
    const l = new KeyedSlotLimit(2, 1);
    const a = l.acquire('a')!;
    expect(l.acquire('a')).toBeNull(); // the same account again
    const b = l.acquire('b')!;
    expect(l.acquire('c')).toBeNull(); // the total is full
    expect([l.inFlight, l.inFlightOf('a'), l.inFlightOf('b')]).toEqual([2, 1, 1]);
    a();
    a(); // idempotent
    expect([l.inFlight, l.inFlightOf('a')]).toEqual([1, 0]);
    expect(l.acquire('c')).not.toBeNull();
    expect(l.acquire('a')).toBeNull(); // total full again (b, c)
    b();
    expect(l.acquire('a')).not.toBeNull();
  });
});

describe('StartQuota: package starts per account and day (review 6800881871, owner 2026-11-11)', () => {
  const limits = { minIntervalMs: 600_000, perKeyPerDay: 4, globalPerDay: 5 };
  it('one start per account per 10 minutes; another account is not affected', () => {
    let t = 0;
    const q = new StartQuota(limits, () => t);
    expect(typeof q.take('a')).toBe('object');
    expect(q.take('a')).toBe('RATE');
    t += 599_999;
    expect(q.take('a')).toBe('RATE');
    expect(typeof q.take('b')).toBe('object');
    t += 1;
    expect(typeof q.take('a')).toBe('object');
  });
  it('at most 4 a day per account, and the global ceiling; both free again after 24 h', () => {
    let t = 0;
    const q = new StartQuota(limits, () => t);
    for (let i = 0; i < 4; i++) {
      expect(typeof q.take('a')).toBe('object');
      t += 600_000;
    }
    expect(q.take('a')).toBe('DAILY');
    expect(typeof q.take('b')).toBe('object'); // the 5th start in total
    expect(q.take('c')).toBe('GLOBAL');
    t += 86_400_000;
    expect(typeof q.take('a')).toBe('object');
    expect(typeof q.take('c')).toBe('object');
  });
  it('a start given back (nothing passed on) costs nothing, once only', () => {
    let t = 0;
    const q = new StartQuota(limits, () => t);
    const s = q.take('a');
    if (typeof s !== 'object') throw new Error('expected a start');
    s.giveBack();
    s.giveBack();
    const again = q.take('a');
    expect(typeof again).toBe('object');
    expect(q.take('a')).toBe('RATE');
    t += 600_000;
    expect(typeof q.take('a')).toBe('object');
  });
});
