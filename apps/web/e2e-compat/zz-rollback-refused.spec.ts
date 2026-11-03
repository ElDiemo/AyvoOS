import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { e2eRows, e2eSql } from '../e2e/e2e-db';

/**
 * The refused return (doc 041 §8b, PR #110): once a payment has a match result an earlier image
 * does not know (PAID_BEFORE_ISSUE), the manual preflight finds it and the return to that image is
 * refused — never a false green. Shown against the real earlier web: its Platby page cannot read the
 * value. Runs last: the row stays (append-only); the e2e database is recreated on every run.
 */
const OLD_ROOT = process.env.AYVO_COMPAT_OLD_ROOT!;
const OLD_WEB = 'http://localhost:3201';
const PREFLIGHT = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/sql/finance-payments-rollback-preflight.sql'),
  'utf8',
);
const status = async (url: string) => (await fetch(url).catch(() => null))?.status ?? 0;

test('a PAID_BEFORE_ISSUE payment: the preflight refuses the return; the earlier web cannot read it', async ({
  page,
}) => {
  // A synthetic payment received before its invoice (as #110 records it); a fixture, never a bank.
  const serial = 9_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  await e2eSql([
    `INSERT INTO finance.incoming_payments (serial, code, source, source_key, environment, amount,
       currency, booked_on, variable_symbol, match_result, recorded_by, recorded_by_name)
     VALUES (${serial}, 'PP-${serial}', 'SIMULATION', 'COMPAT-${serial}', 'SIMULATION', 10.00,
       'CZK', DATE '2026-01-01', '9920260001', 'PAID_BEFORE_ISSUE', gen_random_uuid(), 'compat')`,
  ]);
  const found = await e2eRows<{ match_result: string; payments: number }>(PREFLIGHT);
  expect(found, 'the preflight must find it: the return is refused').toEqual([
    { match_result: 'PAID_BEFORE_ISSUE', payments: expect.any(Number) },
  ]);

  // Why: the earlier web (with this API and Finance) does not render Platby with it.
  const child: ChildProcess = spawn(
    process.execPath,
    [resolve(OLD_ROOT, 'apps/web/node_modules/next/dist/bin/next'), 'start', '--port', '3201'],
    {
      cwd: resolve(OLD_ROOT, 'apps/web'),
      env: {
        ...process.env,
        API_URL: 'http://localhost:4100',
        FINANCE_API_URL: 'http://localhost:4110',
      },
      stdio: 'ignore',
    },
  );
  try {
    await expect.poll(() => status(OLD_WEB), { timeout: 40_000 }).toBeGreaterThan(0);
    const res = await page.goto(`${OLD_WEB}/finance/payments`);
    const listed = await page.getByTestId(`payment-PP-${serial}`).count();
    expect(
      res?.status(),
      `the earlier Platby page fails on the unknown value (the payment listed ${listed}×)`,
    ).toBeGreaterThanOrEqual(500);
  } finally {
    child.kill('SIGKILL');
  }
});
