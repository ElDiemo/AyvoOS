import { describe, expect, it } from 'vitest';
import { boundedPassThrough, SlotLimit } from './slots';

/** An upstream body of n chunks that records whether it was cancelled. */
function upstream(chunks: number, delayMs = 0) {
  const state = { cancelled: false, served: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (state.served >= chunks) return controller.close();
        state.served++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

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
      deadlineMs: 5_000,
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

  it('the browser going away releases the slot and cancels Finance’s response', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    const up = upstream(1000);
    let aborted = false;
    const body = boundedPassThrough(up.body, {
      deadlineMs: 5_000,
      release,
      abortUpstream: () => (aborted = true),
    });
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    expect([slots.inFlight, aborted, up.state.cancelled]).toEqual([0, true, true]);
  });

  it('the deadline cuts a receiver that never reads off, releases the slot and cancels the upstream', async () => {
    const slots = new SlotLimit(1);
    const release = slots.acquire()!;
    const up = upstream(1000);
    let aborted = false;
    const body = boundedPassThrough(up.body, {
      deadlineMs: 100,
      release,
      abortUpstream: () => (aborted = true),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect([slots.inFlight, aborted, up.state.cancelled]).toEqual([0, true, true]);
    await expect(body.getReader().read()).rejects.toThrow('PortalPdfDeadline');
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
      deadlineMs: 5_000,
      release,
      abortUpstream: () => {},
    }).getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) break;
      })(),
    ).rejects.toThrow('finance gone');
    expect(slots.inFlight).toBe(0);
  });
});
