import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from '../e2e/dispatch-setup';
import { e2eRows, e2eSql } from '../e2e/e2e-db';
import {
  filledCrate,
  labelingSetup,
  labelledCrate,
  lotIdOf,
  receiveStock,
} from '../e2e/labeling-setup';

/**
 * DEV TRIAL, isolated and reproducible (doc 070, ~/DEV-TRIAL runbook T1 without a copy of the
 * shared DEV database): the built release (#152 → #154 → #197) on its own recreated e2e database
 * with the FAKE test carrier and SIMULATED carrier events, APP_ENV=test — never DEV, never PPL.
 * Synthetic data only.
 *
 * 1. The previous release (a real process of main 09e82e7 at AYVO_COMPAT_OLD_ROOT) writes the R1
 *    returns that exist before the rollout: a closed receipt, and an open one with an unemptied
 *    crate line and a container holding an unanchored NOT_DELIVERED. The chain's migrations only
 *    add (their one backfill, the R3-a anchor, is also done by its trigger), so these rows are the
 *    rows a migrated DEV holds. The first-write detector stays 0: the rollback is still allowed.
 * 2. The previous process stops (as after the deployment). In the browser, the operator works by
 *    P1 — a receipt is opened only when the return is unloaded: crate K freed with its scan,
 *    8 of 10 bottles on their own (2 stay at the hotel); crate E, delivered by the carrier after
 *    that receipt was opened, is refused there with nothing written → closed, a new receipt for
 *    the E unload; E1's old open issue resolved on the old receipt; the old R1 lines emptied with
 *    a count (migration plan) and closed.
 * Every step: the detector, a screenshot and the result in AYVO_TRIAL_OUT (default
 * test-results/bottle-cycle-trial). Run: doc 070 §8 (playwright.compat.config.ts).
 */
const OLD_ROOT = process.env.AYVO_COMPAT_OLD_ROOT!;
const OLD_API = 'http://localhost:4201';
const OUT = resolve(process.env.AYVO_TRIAL_OUT ?? 'test-results/bottle-cycle-trial');
const DETECTOR = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/sql/bottle-cycle-first-write-detector.sql'),
  'utf8',
);
const C = 10;
test.use({
  storageState: 'e2e/.auth/admin.json',
  timezoneId: 'Europe/Prague',
  actionTimeout: 30_000,
});
test.setTimeout(900_000);

interface Crate {
  url: string;
  code: string;
  bottles: string[];
}
type Detector = Record<string, number | string | null>;
const log: { step: string; detector: Detector; note?: unknown }[] = [];

async function detector(): Promise<Detector> {
  const [row] = await e2eRows<Record<string, unknown>>(DETECTOR);
  return Object.fromEntries(
    Object.entries(row!).map(([k, v]) => [
      k,
      typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : (v as never),
    ]),
  );
}
const ZERO = {
  r11_bottles_lines: 0,
  r11_crate_returned: 0,
  r11_crates_freed: 0,
  r11_anchored_issues: 0,
  r3b_reuse_members: 0,
  r3b_reuse_fillings: 0,
  r3a_unanchored_fillings: 0,
  first_new_write_at: null,
};
async function step(page: Page | null, name: string, note?: unknown) {
  const d = await detector();
  log.push({ step: name, detector: d, note });
  if (page) await page.screenshot({ path: join(OUT, `${log.length}-${name}.png`), fullPage: true });
  writeFileSync(join(OUT, 'trial.json'), JSON.stringify(log, null, 1));
  return d;
}

/** Simulated carrier event (450 delivered / 150 picked up) of one order, then the real tracking. */
async function carrier(request: APIRequestContext, order: string, delivered: boolean) {
  const e = delivered
    ? [450, 'Delivered', 'DELIVERED', 'Zásilku jsme doručili příjemci.']
    : [150, 'PickedUp', 'PICKED_UP', 'Zásilku jsme převzali od odesílatele.'];
  await e2eSql([
    `INSERT INTO "shipment_tracking_events"
       ("shipment_id", "parcel_id", "carrier_code", "carrier_environment", "carrier_parcel_number",
        "status_id", "code", "phase", "event_group", "name", "meaning", "occurred_at", "fetched_at")
     SELECT s."id", p."id", s."carrier_code", s."carrier_environment", p."carrier_parcel_number",
            ${e[0]}, '${e[1]}', NULL, NULL, '${e[3]}', '${e[2]}', now(), now()
       FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
      WHERE o."code" = '${order}' AND s."status" = 'LABELED'
     ON CONFLICT DO NOTHING`,
  ]);
  await json(
    await request.post(`/api/admin/orders/${order}/shipment/tracking/refresh`, {
      data: { requestId: crypto.randomUUID() },
    }),
  );
}

/** Filled crates (new build), an order per group, shipped; `delivered` groups delivered. */
async function seed(request: APIRequestContext) {
  const names = ['A', 'C', 'K', 'E', 'F'];
  const printed = await printedBottles(request, `zkouska-obeh-${Date.now()}`, names.length * C);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: C,
    productName: 'Tekuté mýdlo (zkouška oběhu)',
  });
  await json(
    await request.post(`/api/admin/catalog/products/${kit.productCode}/weights`, {
      data: measurement({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${kit.crateTypeCode}/tare`, {
      data: measurement({ massG: '1850', configuration: 'Bedna s přepážkami' }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${kit.crateTypeCode}/dimensions`, {
      data: measurement({
        subject: 'SHIPPING_PACKAGE',
        lengthMm: 600,
        widthMm: 400,
        heightMm: 300,
        extraPackaging: 'NONE',
        extraDescription: null,
        extraMassG: null,
        extraItemCode: null,
        extraInTare: null,
      }),
    }),
  );
  const n = String(names.length * C);
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', n))!;
  await receiveStock(request, kit.pumpCode, n);
  await receiveStock(request, kit.labelCode, n);
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, String(names.length * C * 400)))!,
  );
  const crates: Record<string, Crate> = {};
  for (const [i, name] of names.entries()) {
    const urls = printed.urls.slice(i * C, i * C + C);
    const crate = await labelledCrate(request, kit, {
      versionId: printed.versionId,
      bottleLotCode: bottleLot,
      urls,
    });
    await filledCrate(request, crate, {
      liquidLotId: liquid,
      bottleUrls: urls,
      category: 'HAND_SOAP',
    });
    crates[name] = { ...crate, bottles: urls };
  }
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  const hotel = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Zkouška oběhu (syntetický)',
          addressLine1: 'Wilsonova 9',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 779',
          contactEmail: 'recepce@zkouska.test',
          fulfillmentSiteId: siteId,
        },
      }),
    )
  ).code;
  const today = (await json<{ today: string }>(await request.get('/api/admin/orders/calendar')))
    .today;
  const ship = async (group: Crate[]) => {
    const order = (
      await json<{ code: string }>(
        await request.post('/api/admin/orders', {
          data: {
            requestId: crypto.randomUUID(),
            hotelCode: hotel,
            requestedShipDate: today,
            lines: [{ productCode: kit.productCode, crates: group.length }],
          },
        }),
      )
    ).code;
    for (const c of group)
      await json(
        await request.post(`/api/admin/orders/${order}/crates`, {
          data: { requestId: crypto.randomUUID(), scannedValue: c.url },
        }),
      );
    await json(
      await request.post(`/api/admin/orders/${order}/complete-and-label`, {
        data: { requestId: crypto.randomUUID(), printerId: null },
      }),
    );
    await json(
      await request.post(`/api/admin/orders/${order}/shipment/ready`, {
        data: { requestId: crypto.randomUUID(), labelsApplied: true },
      }),
    );
    return order;
  };
  const delivered = await ship([crates.A!, crates.C!, crates.K!]);
  await carrier(request, delivered, true);
  const late = await ship([crates.E!, crates.F!]);
  await carrier(request, late, false);
  return { crates, hotel, late };
}

const serverPid = () =>
  Number(readFileSync(join(tmpdir(), 'ayvo-e2e-server-4100.pid'), 'utf8').trim());
function apiEnv() {
  for (const pid of execFileSync('pgrep', ['-P', String(serverPid())], { encoding: 'utf8' })
    .trim()
    .split('\n')) {
    if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dist/main.js')) continue;
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
  }
  throw new Error('the e2e API process was not found');
}
const status = async (url: string) => (await fetch(url).catch(() => null))?.status ?? 0;

async function scanCrate(page: Page, url: string) {
  await page.getByRole('textbox', { name: 'Naskenujte vrácenou bednu' }).fill(url);
  await page.getByRole('button', { name: 'Uvolnit bednu' }).click();
}
async function scanBottle(page: Page, url: string) {
  const card = page.getByTestId('return-bottle-scan');
  await card.getByLabel('Dobrá → čeká na mytí').check();
  await card.getByRole('textbox', { name: /Naskenujte lahev/ }).fill(url);
  await card.getByRole('button', { name: 'Zapsat lahev' }).click();
}
const message = (page: Page) => page.getByTestId('return-message');

test('DEV trial on an isolated reproducible seed: R1 rows of the previous release, then P1 in the browser', async ({
  page,
  browser,
  playwright,
}) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const { crates, hotel, late } = await seed(context.request);
  const { A, C: c, K, E, F } = crates as Record<'A' | 'C' | 'K' | 'E' | 'F', Crate>;
  expect(await step(null, 'seed')).toEqual(ZERO);

  // --- 1. The previous release writes the R1 returns (its own process, same database) --------
  let old: ChildProcess | null = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(OLD_ROOT, 'apps/api'),
    env: { ...apiEnv(), API_PORT: '4201' },
    stdio: 'ignore',
  });
  const legacy: Record<string, string> = {};
  try {
    await expect.poll(() => status(`${OLD_API}/api/health`), { timeout: 60_000 }).toBe(200);
    const r1 = await playwright.request.newContext({
      baseURL: OLD_API,
      storageState: 'e2e/.auth/admin.json',
    });
    const post = (path: string, body: object = {}) =>
      r1.post(`/api/admin/returns${path}`, { data: { requestId: crypto.randomUUID(), ...body } });
    type R1Detail = { code: string; lineDetails: { id: string; crateCode: string | null }[] };
    const detailOf = async (code: string) =>
      json<R1Detail>(await r1.get(`/api/admin/returns/receipts/${code}`));
    const lineOf = async (code: string, crate: string | null) =>
      (await detailOf(code)).lineDetails.find((l) => l.crateCode === crate)!.id;

    // Closed R1 receipt: crate A, all 10 bottles in its line, Vyprázdněno 10, closed.
    const closed = await json<R1Detail>(await post('/receipts', { hotelCode: hotel }));
    await json(await post(`/receipts/${closed.code}/crates`, { scannedValue: A.url }));
    const aLine = await lineOf(closed.code, A.code);
    for (const u of A.bottles)
      await json(
        await post(`/receipts/${closed.code}/lines/${aLine}/bottles`, {
          scannedValue: u,
          outcome: 'GOOD',
        }),
      );
    await json(await post(`/receipts/${closed.code}/lines/${aLine}/empty`, { physicalCount: 10 }));
    await json(await post(`/receipts/${closed.code}/close`));
    // Open R1 receipt: crate C not emptied with C1; a container with E1 (E only picked up →
    // NOT_DELIVERED, unanchored).
    const open = await json<R1Detail>(await post('/receipts', { hotelCode: hotel }));
    await json(await post(`/receipts/${open.code}/crates`, { scannedValue: c.url }));
    const cLine = await lineOf(open.code, c.code);
    await json(
      await post(`/receipts/${open.code}/lines/${cLine}/bottles`, {
        scannedValue: c.bottles[0],
        outcome: 'GOOD',
      }),
    );
    const box = (await json<{ lineId: string }>(await post(`/receipts/${open.code}/containers`)))
      .lineId;
    const nd = await json<{ outcome: string; code: string }>(
      await post(`/receipts/${open.code}/lines/${box}/bottles`, {
        scannedValue: E.bottles[0],
        outcome: 'GOOD',
      }),
    );
    expect(nd).toMatchObject({ outcome: 'ISSUE_RECORDED', code: 'NOT_DELIVERED' });
    // F1 the same way (F is in E's order): the case that shows the order of the steps below.
    expect(
      await json(
        await post(`/receipts/${open.code}/lines/${box}/bottles`, {
          scannedValue: F.bottles[0],
          outcome: 'GOOD',
        }),
      ),
    ).toMatchObject({ outcome: 'ISSUE_RECORDED', code: 'NOT_DELIVERED' });
    legacy.closed = closed.code;
    legacy.open = open.code;
    for (const code of [closed.code, open.code])
      expect((await r1.get(`/api/admin/returns/receipts/${code}`)).status()).toBe(200);
    await r1.dispose();
    expect(await step(null, 'r1-by-previous-release', legacy)).toEqual(ZERO);
  } finally {
    old?.kill('SIGTERM');
    old = null;
  }
  await expect.poll(() => status(`${OLD_API}/api/health`), { timeout: 20_000 }).toBe(0);

  // --- 2. This release, P1: a receipt only for an unloaded return --------------------------
  await page.goto(`/production/cycle/returns/${legacy.open}`);
  await expect(
    page.getByText('Starší kontejner z doby před uvolňováním beden').first(),
  ).toBeVisible();
  expect(await step(page, 'old-r1-receipt-in-new-ui')).toEqual(ZERO);

  // K unloaded → a new receipt; its crate scan is the first R1.1 write (the point of no return).
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  const kReceipt = page.url().split('/').pop()!;
  expect(await step(page, 'p1-receipt-k-opened')).toEqual(ZERO);
  await scanCrate(page, K.url);
  await expect(message(page)).toContainText(`Bedna ${K.code} přijata a uvolněna`);
  await expect(page.getByTestId(`return-line-${K.code}`).getByTestId('line-freed')).toContainText(
    'ukončena vazba 10 lahví',
  );
  const first = await step(page, 'first-write-crate-k');
  // r11_crate_returned counts the ended memberships (10 bottles), r11_crates_freed the crate line.
  expect(first).toMatchObject({ r11_crate_returned: 10, r11_crates_freed: 1 });
  expect(first.first_new_write_at).not.toBeNull();
  for (const u of K.bottles.slice(0, 8)) {
    await scanBottle(page, u);
    await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  }
  await expect(page.getByTestId('receipt-counts')).toHaveText(
    'Bedny 1 · přijaté lahve 8 (z toho ke skartaci 0) · nečitelné 0',
  );
  await expect(page.getByTestId(`return-line-${K.code}`).getByTestId('line-history')).toContainText(
    'bez potvrzeného návratu 2',
  );
  await noOverflow(page);
  const afterK = await step(page, 'k-8-of-10-bottles');

  // E is delivered by the carrier only now (after this receipt was opened): refused here.
  await carrier(context.request, late, true);
  await scanCrate(page, E.url);
  await expect(message(page)).toContainText(
    'Bedna byla doručena až po otevření tohoto příjmu – přijměte ji v novém příjmu. Nic se nezapsalo.',
  );
  expect(await step(page, 'e-refused-in-earlier-receipt')).toEqual(afterK);

  // P1: close it. Before the E/F unload is received, the old R1 receipt's open issues of those
  // crates are resolved (E1 here) — the order the trial recommends (see F below).
  await page.getByRole('button', { name: 'Uzavřít příjem' }).click();
  await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
  await page.goto(`/production/cycle/returns/${legacy.open}`);
  // It cannot be closed yet: its R1 lines wait for Vyprázdněno with a count.
  await expect(page.getByRole('button', { name: 'Uzavřít příjem' })).toBeDisabled();
  await expect(
    page.getByText('Nejdřív vyprázdněte starší kontejnery tohoto příjmu (Vyprázdněno).'),
  ).toBeVisible();
  const identify = async (url: string) => {
    const issue = page
      .getByTestId('line-issues')
      .locator('li')
      .filter({ hasText: 'zatím není doručená' })
      .filter({ has: page.getByRole('textbox', { name: /Dořešit naskenováním lahve/ }) })
      .first();
    await issue.getByLabel('Dobrá → čeká na mytí').check();
    await issue.getByRole('textbox', { name: /Dořešit naskenováním lahve/ }).fill(url);
    await issue.getByRole('button', { name: 'Dořešit' }).click();
  };
  // E1's issue: the first open one (E1 was recorded before F1).
  await identify(E.bottles[0]!);
  await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  await step(page, 'old-r1-e1-identified');

  // The new receipt for the E/F unload.
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).not.toHaveURL(new RegExp(`${kReceipt}$`));
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  const eReceipt = page.url().split('/').pop()!;
  await scanCrate(page, E.url);
  await expect(message(page)).toContainText(`Bedna ${E.code} přijata a uvolněna`);
  await expect(page.getByTestId(`return-line-${E.code}`).getByTestId('line-freed')).toContainText(
    'ukončena vazba 9 lahví',
  );
  for (const u of E.bottles.slice(1)) {
    await scanBottle(page, u);
    await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  }
  await scanBottle(page, E.bottles[0]!);
  await expect(message(page)).toContainText('Lahev už byla přijata v jiném příjmu');
  // FINDING (migration window, R1 data): F is freed while F1 still has its OLD unanchored
  // NOT_DELIVERED. F1 is then refused here (open issue) and the old issue can no longer identify
  // it (its crate membership has ended): only a supervisor's close-out remains.
  await scanCrate(page, F.url);
  await expect(page.getByTestId(`return-line-${F.code}`).getByTestId('line-freed')).toContainText(
    'ukončena vazba 10 lahví',
  );
  for (const u of F.bottles.slice(1)) {
    await scanBottle(page, u);
    await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  }
  await scanBottle(page, F.bottles[0]!);
  await expect(message(page)).toContainText(
    'Lahev má otevřenou neshodu – dořešte ji u té neshody.',
  );
  await expect(page.getByTestId('receipt-counts')).toHaveText(
    'Bedny 2 · přijaté lahve 18 (z toho ke skartaci 0) · nečitelné 0',
  );
  await step(page, 'p1-new-receipt-e-f');

  await page.goto(`/production/cycle/returns/${legacy.open}`);
  const before = await detector();
  await identify(F.bottles[0]!);
  await expect(message(page)).toContainText('Lahev není v oběhu – neshoda zůstává otevřená.');
  expect(await detector()).toEqual(before);
  await step(page, 'finding-f1-stuck');

  // The old R1 lines emptied with a count (the migration plan), then closed; F1's issue stays open.
  for (const [testId, count] of [
    [`return-line-${c.code}`, '1'],
    ['return-line-box-2', '2'],
  ] as const) {
    const line = page.getByTestId(testId);
    await line
      .getByRole('textbox', { name: 'Fyzicky vyjmuto z tohoto kontejneru (ks)' })
      .fill(count);
    await line.getByRole('button', { name: 'Vyprázdněno' }).click();
    await expect(line.getByTestId('line-recorded')).toContainText(
      `Vyprázdněno · fyzicky ${count} ks`,
    );
  }
  await page.getByRole('button', { name: 'Uzavřít příjem' }).click();
  await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
  await step(page, 'old-r1-emptied-and-closed');

  // Every bottle once: A 10 and C1 (R1), K 8, E 10, F 9 — 2 of K at the hotel, F1 open.
  const counted = await e2eRows<{ n: bigint }>(
    `SELECT count(DISTINCT b."id") AS n FROM "bottles" b WHERE b."status" = 'RETURNED'`,
  );
  await page.goto('/production/cycle/returns');
  await step(page, 'overview', {
    receipts: { ...legacy, k: kReceipt, ef: eReceipt },
    returnedBottles: Number(counted[0]!.n),
  });
  expect(Number(counted[0]!.n)).toBe(10 + 1 + 8 + 10 + 9);
  await context.close();
});
