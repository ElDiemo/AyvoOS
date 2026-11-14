// Test-only outage control of the e2e Finance process (start-e2e-server.mjs, the specs that stop
// Finance on purpose: workflow-finance-outage, workflow-finance-payers-hotels, the full walk).
//
// stop():    SIGTERM, and SIGKILL if the process is still alive after `graceMs` — a slow graceful
//            shutdown must not leave Finance "ready" past a spec's wait. Idempotent during one
//            shutdown (one timer per process), and the timer only ever kills the process it was set
//            for — never a replacement started meanwhile.
// restart(): a new process; if the stopped one has not exited yet, the restart waits for its exit
//            instead of being dropped. (Before: a SIGUSR1 during a slow shutdown was ignored, the
//            old process exited later and Finance stayed down for the rest of the run — CI 42885700358:
//            one failed outage step, then every later Finance spec failed with ECONNREFUSED.)
// An exit that was not requested ends the run through `onUnexpectedExit` (a broken unit must fail).

/**
 * @param {{ start: () => import('node:child_process').ChildProcess,
 *           onUnexpectedExit: (code: number | null) => void, graceMs?: number }} options
 */
export function financeOutageControl({ start, onUnexpectedExit, graceMs = 5000 }) {
  let child = start();
  let stopped = false;
  let restartWanted = false;
  /** @type {NodeJS.Timeout | null} */
  let killTimer = null;
  const isAlive = (/** @type {import('node:child_process').ChildProcess} */ p) =>
    p.exitCode === null && p.signalCode === null;
  const watch = (/** @type {import('node:child_process').ChildProcess} */ p) =>
    p.on('exit', (code) => onExit(p, code));
  const launch = () => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
    stopped = false;
    restartWanted = false;
    child = start();
    watch(child);
  };
  function onExit(
    /** @type {import('node:child_process').ChildProcess} */ p,
    /** @type {number | null} */ code,
  ) {
    if (p !== child) return; // a replaced process: its exit was handled already
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
    if (!stopped) return onUnexpectedExit(code);
    if (restartWanted) launch();
  }
  watch(child);
  return {
    get child() {
      return child;
    },
    stop() {
      stopped = true;
      restartWanted = false;
      // Already exited, or already being stopped (its timer is set): nothing more to send.
      if (!isAlive(child) || killTimer) return;
      const target = child;
      target.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (isAlive(target)) target.kill('SIGKILL');
      }, graceMs);
    },
    restart() {
      if (!stopped) return;
      if (isAlive(child)) restartWanted = true;
      else launch();
    },
  };
}
