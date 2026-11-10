// Test-only outage control of the e2e Finance process (start-e2e-server.mjs, the specs that stop
// Finance on purpose: workflow-finance-outage, workflow-finance-payers-hotels, the full walk).
//
// stop():    SIGTERM, and SIGKILL if the process is still alive after `graceMs` — a slow graceful
//            shutdown must not leave Finance "ready" past a spec's wait.
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
  const alive = () => child.exitCode === null && child.signalCode === null;
  const launch = () => {
    stopped = false;
    restartWanted = false;
    child = start();
    child.on('exit', onExit);
  };
  function onExit(/** @type {number | null} */ code) {
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
    if (!stopped) return onUnexpectedExit(code);
    if (restartWanted) launch();
  }
  child.on('exit', onExit);
  return {
    get child() {
      return child;
    },
    stop() {
      stopped = true;
      restartWanted = false;
      if (!alive()) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (alive()) child.kill('SIGKILL');
      }, graceMs);
    },
    restart() {
      if (!stopped) return;
      if (alive()) restartWanted = true;
      else launch();
    },
  };
}
