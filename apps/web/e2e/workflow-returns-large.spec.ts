import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { json } from './dispatch-setup';
import { deliveredReceipt, type SeededCrate } from './returns-receipt-setup';

/**
 * MEASUREMENT (opt-in: E2E_RECEIPT_PERF=1, never in CI): one large receipt walked through in the
 * browser like an operator with a keyboard scanner — N crates × C bottles delivered by SIMULATED
 * carrier events (the recreated e2e database only), every crate scanned and freed, all but the
 * last bottle of each crate scanned on their own. Midway ANOTHER operator (the API, same receipt)
 * identifies 5 bottles and records an unreadable piece: the next scan in the browser must show
 * them. At the end "Zobrazit všechny" and 10 more scans in that view (the full list each time).
 * Per scan: from the click until the message AND the running total are on the screen. The result
 * is written to E2E_PERF_OUT. Synthetic data, FAKE test carrier only.
 */
const N = Number(process.env.E2E_PERF_CRATES ?? 50);
const C = 10;
test.skip(!process.env.E2E_RECEIPT_PERF, 'measurement only (E2E_RECEIPT_PERF=1)');
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(3_600_000);

let receipt = '';
const crates: SeededCrate[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(3_600_000);
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const t0 = Date.now();
  const seeded = await deliveredReceipt(context.request, {
    crates: N,
    capacity: C,
    name: 'Velký příjem',
  });
  receipt = seeded.receipt;
  crates.push(...seeded.crates);
  console.log(`seed ${N}×${C} in ${Math.round((Date.now() - t0) / 1000)} s, receipt ${receipt}`);
  await context.close();
});

const counts = (crates: number, identified: number, unreadable: number) =>
  `Bedny ${crates} · přijaté lahve ${identified} (z toho ke skartaci 0) · nečitelné ${unreadable}`;

async function timed(page: Page, field: string, button: string, value: string, expected: string) {
  const start = Date.now();
  await page.getByRole('textbox', { name: field }).fill(value);
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByTestId('receipt-counts')).toHaveText(expected, { timeout: 60_000 });
  // The form is free again (the next scan can go).
  await expect(page.getByRole('button', { name: button })).toBeEnabled({ timeout: 60_000 });
  return Date.now() - start;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

test(`large receipt in the browser: ${N} crates × ${C} bottles`, async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const detailGets: { bytes: number }[] = [];
  page.on('response', async (r) => {
    if (
      r.request().method() === 'GET' &&
      r.url().includes(`/api/admin/returns/receipts/${receipt}`)
    ) {
      detailGets.push({ bytes: (await r.body().catch(() => Buffer.alloc(0))).length });
    }
  });
  const passStart = Date.now();
  await page.goto(`/production/cycle/returns/${receipt}`);
  await expect(page.getByTestId('receipt-state')).toContainText('Otevřený');
  const crateMs: number[] = [];
  const bottleMs: number[] = [];
  let identified = 0;
  let unreadable = 0;
  const other = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (let i = 0; i < N; i++) {
    const c = crates[i]!;
    crateMs.push(
      await timed(
        page,
        'Naskenujte vrácenou bednu',
        'Uvolnit bednu',
        c.url,
        counts(i + 1, identified, unreadable),
      ),
    );
    for (let b = 0; b < C - 1; b++) {
      identified++;
      bottleMs.push(
        await timed(
          page,
          'Naskenujte lahev',
          'Zapsat lahev',
          c.bottles[b]!,
          counts(i + 1, identified, unreadable),
        ),
      );
    }
    if (i === Math.floor(N / 2)) {
      // ANOTHER operator, same receipt: the last bottle of crates 0–4 and an unreadable piece.
      for (let k = 0; k < 5; k++) {
        await json(
          await other.request.post(`/api/admin/returns/receipts/${receipt}/bottles`, {
            data: {
              requestId: crypto.randomUUID(),
              scannedValue: crates[k]!.bottles[C - 1],
              outcome: 'GOOD',
            },
          }),
        );
      }
      await json(
        await other.request.post(`/api/admin/returns/receipts/${receipt}/unreadable`, {
          data: { requestId: crypto.randomUUID() },
        }),
      );
      identified += 5;
      unreadable += 1;
    }
  }
  const passMs = Date.now() - passStart;
  // The other operator's unreadable piece is on the screen, and so is every received bottle.
  const bottlesCard = page.getByTestId('return-line-bottles');
  const listed = bottlesCard.getByTestId('line-bottles').locator('li');
  await expect(bottlesCard.getByText('Nečitelná', { exact: false }).first()).toBeVisible();
  await expect(listed).toHaveCount(Math.min(identified, 20));
  // "Zobrazit všechny" and further scans in that view: the full list stays, one more each time.
  const showAllStart = Date.now();
  await bottlesCard.getByRole('button', { name: /Zobrazit všechny/ }).click();
  await expect(listed).toHaveCount(identified, { timeout: 60_000 });
  const showAllMs = Date.now() - showAllStart;
  const allModeMs: number[] = [];
  for (const c of crates.slice(5, 15)) {
    identified++;
    allModeMs.push(
      await timed(
        page,
        'Naskenujte lahev',
        'Zapsat lahev',
        c.bottles[C - 1]!,
        counts(N, identified, unreadable),
      ),
    );
    await expect(listed).toHaveCount(identified);
    await expect(bottlesCard.getByTestId('line-bottles-recent')).toHaveCount(0);
  }
  await other.close();
  const result = {
    build: process.env.E2E_PERF_LABEL ?? '',
    crates: N,
    capacity: C,
    scans: crateMs.length + bottleMs.length,
    passSeconds: Math.round(passMs / 100) / 10,
    crate: { p50: pct(crateMs, 50), p95: pct(crateMs, 95), max: Math.max(...crateMs) },
    bottle: { p50: pct(bottleMs, 50), p95: pct(bottleMs, 95), max: Math.max(...bottleMs) },
    lastTenBottles: bottleMs.slice(-10),
    firstTenBottles: bottleMs.slice(0, 10),
    showAllMs,
    allMode: { scans: allModeMs.length, p50: pct(allModeMs, 50), max: Math.max(...allModeMs) },
    detailGets: detailGets.length,
    detailMB: Math.round(detailGets.reduce((s, g) => s + g.bytes, 0) / 1e4) / 100,
    lastDetailKB: Math.round((detailGets.at(-1)?.bytes ?? 0) / 100) / 10,
  };
  console.log(JSON.stringify(result));
  if (process.env.E2E_PERF_OUT)
    writeFileSync(process.env.E2E_PERF_OUT, JSON.stringify(result, null, 1));
});
