import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { financeOutageControl } from '../scripts/e2e-finance-outage.mjs';

/**
 * The e2e server's test-only control of the Finance process (CI 42885700358: a slow graceful
 * shutdown kept Finance "ready" past the spec's 15 s wait, the SIGUSR1 sent meanwhile was dropped,
 * and Finance stayed down for the rest of the run). Real child processes stand in for Finance.
 */
const children: ChildProcess[] = [];
/** A process that, like a slow graceful shutdown, ignores SIGTERM (or not) and stays up. */
const fake = (ignoreTerm: boolean) => () => {
  const c = spawn(
    process.execPath,
    ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000);`],
    { stdio: 'ignore' },
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
const started = (c: ChildProcess) =>
  new Promise<void>((r) => (c.pid ? r() : c.once('spawn', () => r())));

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
    await started(unit.child);
    await new Promise((r) => setTimeout(r, 200)); // the child's SIGTERM handler is installed
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
    await started(first);
    await new Promise((r) => setTimeout(r, 200));
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
    await started(first);
    unit.stop();
    expect(await until(() => !alive(first))).toBe(true);
    unit.restart();
    const second = unit.child;
    expect(second).not.toBe(first);
    await started(second);
    expect(unexpected).toBe('none');
    second.kill('SIGKILL'); // an unrequested exit
    expect(await until(() => unexpected !== 'none')).toBe(true);
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
