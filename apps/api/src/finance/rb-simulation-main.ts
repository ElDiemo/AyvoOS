import { readFileSync } from 'node:fs';
import { RB_SIMULATION_PORT, rbSimulationServer } from './rb-simulation.js';

// The DEV bank simulation's entry point (doc 036 §10a): `node dist/finance/rb-simulation-main.js`
// in the `rb-simulation` container of the DEV Compose project only. Never in production: it
// refuses to start there, and the production Compose project has no such service.
if (process.env.APP_ENV !== 'development') {
  console.error('rb-simulation: only with APP_ENV=development (the DEV preview)');
  process.exit(1);
}
const dir = process.env.RB_SIMULATION_DIR ?? '/run/secrets/rb-simulation';
const accounts = (process.env.RB_PREMIUM_ACCOUNTS ?? '').split(',').filter(Boolean);
if (accounts.length === 0) {
  console.error('rb-simulation: RB_PREMIUM_ACCOUNTS is empty');
  process.exit(1);
}
const read = (name: string) => readFileSync(`${dir}/${name}`);
const server = rbSimulationServer({
  key: read('server.key'),
  cert: read('server.crt'),
  ca: read('ca.crt'),
  clientId: read('client-id')
    .toString('utf8')
    .replace(/\r?\n$/, ''),
  accounts,
});
server.listen(RB_SIMULATION_PORT, () =>
  console.log(`rb-simulation: listening on ${RB_SIMULATION_PORT} (${accounts.length} account(s))`),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
