/** A fixed number of slots; `acquire` never waits (the rest are refused at once, ADR 0045 §8). */
export class SlotLimit {
  private active = 0;
  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  /** A release function (idempotent), or null when every slot is taken. */
  acquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}

/**
 * A body passed through without buffering it: the browser pulls each chunk from the upstream
 * (backpressure), so a slow receiver holds at most one chunk here. `release` runs exactly once
 * when the transfer ends — completed, failed, cancelled by the browser, or cut off at `deadlineMs`
 * — and the upstream is aborted on every early end.
 */
export function boundedPassThrough(
  upstream: ReadableStream<Uint8Array>,
  options: { deadlineMs: number; release: () => void; abortUpstream: () => void },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let finished = false;
  const finish = (early: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    if (early) {
      options.abortUpstream();
      void reader.cancel().catch(() => undefined);
    }
    options.release();
  };
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const deadline = setTimeout(() => {
    finish(true);
    controllerRef?.error(new Error('PortalPdfDeadline'));
  }, options.deadlineMs);
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            controller.close();
            finish(false);
          } else controller.enqueue(value);
        } catch (error) {
          finish(true);
          controller.error(error);
        }
      },
      cancel() {
        finish(true);
      },
    },
    { highWaterMark: 0 },
  );
}
