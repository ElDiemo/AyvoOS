import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0041: both deploy scripts refuse a missing, weak or reused CORE_DB_PASSWORD before anything
 * is changed — the real check functions taken from the scripts, values never printed.
 */
const root = resolve(import.meta.dirname, '../../..');
const fn = (script: string, name: string) => {
  const text = readFileSync(join(root, 'scripts', script), 'utf8');
  const i = text.indexOf(`\n${name}() {`);
  expect(i, name).toBeGreaterThan(0);
  return text.slice(i + 1, text.indexOf('\n}\n', i) + 2);
};
const bash = (body: string) => spawnSync('bash', ['-c', body], { encoding: 'utf8' });
const HELPERS = 'die() { echo "DIE $*"; exit 1; }\nok() { echo "OK $*"; }\n';
const privileged = 'p'.repeat(32);
const core = 'c'.repeat(32);

describe('deploy-prod.sh: CORE_DB_PASSWORD', () => {
  const check = (value: string) =>
    bash(`${HELPERS}${fn('deploy-prod.sh', 'check_core_db_password')}
check_core_db_password '${value}' '${privileged}'`);

  it('accepts its own URL-safe password', () => {
    expect(check(core).stdout).toContain('OK CORE_DB_PASSWORD set');
  });
  it.each([
    ['empty', ''],
    ['too short', 'c'.repeat(23)],
    ['not URL-safe', `${'c'.repeat(30)}@x`],
    ['the privileged password', privileged],
  ])('refuses %s', (_, value) => {
    const res = check(value);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('DIE CORE_DB_PASSWORD');
    if (value) expect(res.stdout).not.toContain(value);
  });
});

describe('deploy-dev.sh: CORE_DB_PASSWORD', () => {
  const script = readFileSync(join(root, 'scripts/deploy-dev.sh'), 'utf8');
  it('is a required variable, checked for format and for differing from POSTGRES_PASSWORD', () => {
    expect(script).toMatch(/REQUIRED_VARS=\([^)]*CORE_DB_PASSWORD/);
    expect(script).toContain('${CFG[CORE_DB_PASSWORD]} =~ ^[A-Za-z0-9_-]{24,128}$');
    expect(script).toContain('${CFG[CORE_DB_PASSWORD]} != "${CFG[POSTGRES_PASSWORD]}"');
  });
});
