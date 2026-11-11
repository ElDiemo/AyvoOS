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
 * Slots counted globally AND per key (e.g. per portal account): `acquire(key)` takes one of each
 * or none — refused at once when either is full. The release (idempotent) frees both.
 */
export class KeyedSlotLimit {
  private active = 0;
  private readonly perKey = new Map<string, number>();
  constructor(
    private readonly max: number,
    private readonly maxPerKey: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }
  inFlightOf(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  acquire(key: string): (() => void) | null {
    if (this.active >= this.max || this.inFlightOf(key) >= this.maxPerKey) return null;
    this.active++;
    this.perKey.set(key, this.inFlightOf(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = this.inFlightOf(key) - 1;
      if (left > 0) this.perKey.set(key, left);
      else this.perKey.delete(key);
    };
  }
}

/**
 * Starts of invoice packages in time (review 6800881871; owner 2026-11-11: a package is fetched
 * about once or twice a month): per key (a portal account) at most one start per `minIntervalMs`
 * and `perKeyPerDay` in 24 h, and `globalPerDay` in 24 h in total. With the concurrency of
 * KeyedSlotLimit this bounds how many packages can ever be in transfer or parked in buffers on the
 * way, whatever the client's speed. A start that passed nothing on (a refusal, no slot) is given
 * back. Kept in this process: portal-web runs as one process (DEV and PROD); a restart forgets the
 * starts — at worst one more start per account.
 */
export class StartQuota {
  private readonly starts = new Map<string, number[]>();
  private all: number[] = [];
  constructor(
    private readonly limits: { minIntervalMs: number; perKeyPerDay: number; globalPerDay: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** A start (its `giveBack` frees it again), or why not. */
  take(key: string): { giveBack: () => void } | 'RATE' | 'DAILY' | 'GLOBAL' {
    const t = this.now();
    const since = t - 86_400_000;
    const mine = (this.starts.get(key) ?? []).filter((x) => x > since);
    this.all = this.all.filter((x) => x > since);
    const last = mine.at(-1);
    if (last !== undefined && t - last < this.limits.minIntervalMs) return 'RATE';
    if (mine.length >= this.limits.perKeyPerDay) return 'DAILY';
    if (this.all.length >= this.limits.globalPerDay) return 'GLOBAL';
    mine.push(t);
    this.starts.set(key, mine);
    this.all.push(t);
    let given = false;
    return {
      giveBack: () => {
        if (given) return;
        given = true;
        const list = this.starts.get(key) ?? [];
        const i = list.lastIndexOf(t);
        if (i >= 0) list.splice(i, 1);
        const j = this.all.lastIndexOf(t);
        if (j >= 0) this.all.splice(j, 1);
      },
    };
  }
}

/** Why a bounded transfer ended early (the stream is errored with it). */
export class TransferCut extends Error {
  constructor(readonly reason: 'DEADLINE' | 'TOO_LARGE' | 'UPSTREAM' | 'CLIENT') {
    super(`PortalTransferCut:${reason}`);
  }
}

/**
 * Cancels a reader and waits until the cancellation has really finished (or failed): only then
 * is the upstream's resource known to be given back (review 5818694161).
 */
async function settleCancel(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown) {
  await reader.cancel(reason).catch(() => undefined);
}

/**
 * One deadline for a whole request (fetch, reading and the answer), also ended by `also` (the
 * browser leaving). `signal` is passed to everything the request does; `done` ends the timer.
 */
export function deadline(ms: number, also?: AbortSignal) {
  const controller = new AbortController();
  const onAlso = () => controller.abort(new TransferCut('CLIENT'));
  const timer = setTimeout(() => controller.abort(new TransferCut('DEADLINE')), ms);
  const done = () => {
    clearTimeout(timer);
    also?.removeEventListener('abort', onAlso);
  };
  controller.signal.addEventListener('abort', done, { once: true });
  if (also?.aborted) onAlso();
  else also?.addEventListener('abort', onAlso, { once: true });
  return { signal: controller.signal, done };
}

/**
 * A body passed through without buffering it: the browser pulls each chunk from the upstream
 * (backpressure), so a slow receiver holds at most one chunk here.
 *
 * - **One deadline:** `stop` is the request's single signal (the deadline that already covered
 *   the upstream fetch, and the browser leaving). When it fires, the transfer is cut.
 * - **A byte limit:** more than `maxBytes` (whatever Content-Length said) cuts the transfer.
 * - **Release after cleanup:** on every early end the upstream is aborted, its reader cancelled,
 *   and `release` runs only after that cancellation has settled — a slot is never handed to the
 *   next request while the previous upstream is still being torn down. On a completed transfer
 *   `release` runs once the last byte was read.
 */
export function boundedPassThrough(
  upstream: ReadableStream<Uint8Array>,
  options: {
    stop: AbortSignal;
    maxBytes: number;
    release: () => void;
    abortUpstream: () => void;
  },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let finished = false;
  let bytes = 0;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const finish = async (cut: TransferCut | null) => {
    if (finished) return;
    finished = true;
    options.stop.removeEventListener('abort', onStop);
    try {
      if (cut) {
        options.abortUpstream();
        await settleCancel(reader, cut);
      }
    } finally {
      options.release();
    }
  };
  const fail = (cut: TransferCut) => {
    try {
      controllerRef?.error(cut);
    } catch {
      // already closed or errored
    }
    return finish(cut);
  };
  function onStop() {
    void fail(new TransferCut('DEADLINE'));
  }

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        if (options.stop.aborted) onStop();
        else options.stop.addEventListener('abort', onStop, { once: true });
      },
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (!finished)
            await fail(new TransferCut(options.stop.aborted ? 'DEADLINE' : 'UPSTREAM'));
          return;
        }
        if (finished) return;
        if (chunk.done) {
          controller.close();
          await finish(null);
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > options.maxBytes) {
          await fail(new TransferCut('TOO_LARGE'));
          return;
        }
        controller.enqueue(chunk.value);
      },
      async cancel() {
        await finish(new TransferCut('CLIENT'));
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Reads a whole (small) body with a byte limit and the caller's deadline, without trusting a
 * Content-Length. Throws `TransferCut` (TOO_LARGE / DEADLINE / UPSTREAM) only after the reader's
 * cancellation has settled.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  options: { maxBytes: number; stop: AbortSignal },
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let onStop = () => {};
  const stopped = new Promise<'stop'>((resolve) => {
    onStop = () => resolve('stop');
    if (options.stop.aborted) resolve('stop');
    else options.stop.addEventListener('abort', onStop, { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]).catch(() => 'error' as const);
      if (next === 'stop' || next === 'error') {
        const cut = new TransferCut(
          next === 'stop' || options.stop.aborted ? 'DEADLINE' : 'UPSTREAM',
        );
        await settleCancel(reader, cut);
        throw cut;
      }
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > options.maxBytes) {
        const cut = new TransferCut('TOO_LARGE');
        await settleCancel(reader, cut);
        throw cut;
      }
      chunks.push(next.value);
    }
  } finally {
    options.stop.removeEventListener('abort', onStop);
  }
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A Content-Length that is present must be a plain decimal within `max`; absent is allowed. */
export function contentLengthWithin(value: string | null, max: number): boolean {
  if (value === null) return true;
  return /^\d{1,12}$/.test(value) && Number(value) <= max;
}
