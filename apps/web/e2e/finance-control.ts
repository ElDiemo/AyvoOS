import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A real outage of the Finance process, controlled by the e2e server (apps/api/scripts/
 * start-e2e-server.mjs). Each call returns only when it has happened: `stop` when the process has
 * exited, `start` when a new one answers ready (a running one is left as it is). A failure throws
 * with the server's reason.
 */
async function financeControl(action: 'stop' | 'start'): Promise<void> {
  const { port, token } = JSON.parse(
    readFileSync(join(tmpdir(), 'ayvo-e2e-control-4100.json'), 'utf8'),
  ) as { port: number; token: string };
  const res = await fetch(`http://127.0.0.1:${port}/finance/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Finance ${action}: ${res.status} ${await res.text()}`);
}

export const stopFinance = () => financeControl('stop');
export const startFinance = () => financeControl('start');

/** Finance is down while `during` runs and running again afterwards — also when `during` fails. */
export async function withFinanceDown(during: () => Promise<void>): Promise<void> {
  await stopFinance();
  try {
    await during();
  } finally {
    await startFinance();
  }
}
