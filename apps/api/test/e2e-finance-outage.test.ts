import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { financeOutageControl } from '../scripts/e2e-finance-outage.mjs';

/**
 * The e2e server's test-only control of the Finance process (CI 42885700358: a slow graceful
 * shutdown kept Finance "ready" past the spec's 15 s wait, the SIGUSR1 sent meanwhile was dropped,
 * and Finance stayed down for the rest of the run). Real child processes stand in for Finance.
 */
const children: ChildProcess[] = [];
/**
 * A process that, like a slow graceful shutdown, ignores SIGTERM (or not) and stays up. It says
 * "ready" on stdout once its SIGTERM handler is installed — tests wait for that, not for a delay.
 */
const fake = (ignoreTerm: boolean) => () => {
  const c = spawn(
    process.execPath,
    [
      '-e',
      `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(c);
  return c;
};
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves once the fake has announced readiness (its signal handlers are in place). */
const ready = (c: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes('ready\n')) {
        c.stdout?.off('data', onData);
        resolve();
      }
    };
    c.stdout?.on('data', onData);
    c.once('exit', () => reject(new Error('the fake exited before it was ready')));
  });

afterEach(() => {
  for (const c of children) if (alive(c)) c.kill('SIGKILL');
  children.length = 0;
});

describe('e2e Finance outage control', () => {
  it('a stop that SIGTERM does not end is completed with SIGKILL after the grace', async () => {
    let unexpected = false;
    const unit = financeOutageControl({
      start: fake(true),
      onUnexpectedExit: () => (unexpected = true),
      graceMs: 200,
    });
    await ready(unit.child);
    unit.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(unit.child)).toBe(true); // SIGTERM ignored, within the grace
    expect(await until(() => !alive(unit.child), 2000)).toBe(true);
    expect(unit.child.signalCode).toBe('SIGKILL');
    expect(unexpected).toBe(false); // a requested stop
  });

  it('CI 42885700358: a restart while the stopped process is still exiting is not dropped', async () => {
    let unexpected = false;
    const unit = financeOutageControl({
      start: fake(true),
      onUnexpectedExit: () => (unexpected = true),
      graceMs: 300,
    });
    const first = unit.child;
    await ready(first);
    unit.stop();
    unit.restart(); // the spec's `finally` while Finance is still shutting down
    expect(await until(() => !alive(first), 2000)).toBe(true);
    expect(await until(() => unit.child !== first && alive(unit.child), 2000)).toBe(true);
    expect(unexpected).toBe(false); // the requested stop of the first process
  });

  it('a stop and a restart after a normal exit; an exit nobody asked for ends the run', async () => {
    let unexpected: number | null | 'none' = 'none';
    const unit = financeOutageControl({
      start: fake(false),
      onUnexpectedExit: (code) => (unexpected = code),
      graceMs: 200,
    });
    const first = unit.child;
    await ready(first);
    unit.stop();
    expect(await until(() => !alive(first))).toBe(true);
    unit.restart();
    const second = unit.child;
    expect(second).not.toBe(first);
    await ready(second);
    expect(unexpected).toBe('none');
    second.kill('SIGKILL'); // an unrequested exit
    expect(await until(() => unexpected !== 'none')).toBe(true);
  });

  it('a second stop during one shutdown never kills the replacement started after it', async () => {
    // Review of 546d902: two stops set two timers; the first one, left running, later SIGKILLed the
    // replacement through the shared `child` and the run ended as an unexpected Finance exit.
    let unexpected = false;
    const graceMs = 300;
    const unit = financeOutageControl({
      start: fake(false), // exits on SIGTERM, well within the grace
      onUnexpectedExit: () => (unexpected = true),
      graceMs,
    });
    const first = unit.child;
    await ready(first);
    unit.stop();
    unit.stop();
    unit.restart();
    expect(await until(() => !alive(first), 2000)).toBe(true);
    expect(first.signalCode).toBe('SIGTERM');
    expect(await until(() => unit.child !== first, 2000)).toBe(true);
    const second = unit.child;
    await ready(second);
    await sleep(graceMs * 2); // every timer of the first shutdown has run out
    expect(alive(second)).toBe(true);
    expect(unit.child).toBe(second);
    expect(unexpected).toBe(false);
  });

  it('a restart without a stop does nothing', async () => {
    const unit = financeOutageControl({
      start: fake(false),
      onUnexpectedExit: () => undefined,
    });
    const first = unit.child;
    unit.restart();
    expect(unit.child).toBe(first);
  });
});
