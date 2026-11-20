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
 *    the E/F unload. The old open issues are resolved on the old receipt — E1 before its crate is
 *    freed, F1 after it (#208): each counted once in the circulation its issue recorded, a rescan
 *    in the new receipt never counts it again.
 * 3. G1's old issue was recorded while G was allocated to an order that was then cancelled; G went
 *    out with a later order (another circulation). The old issue never takes it over
 *    (CIRCULATION_CHANGED, nothing written); after a supervisor's close-out the new receipt counts
 *    G1 once. The old R1 lines emptied with a count (migration plan) and closed.
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
  const names = ['A', 'C', 'K', 'E', 'F', 'G'];
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
  const allocate = async (group: Crate[]) => {
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
    return order;
  };
  const ship = async (group: Crate[]) => {
    const order = await allocate(group);
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
  // G: allocated to an order (not picked up yet) — that order is cancelled later.
  const cancelled = await allocate([crates.G!]);
  return { crates, hotel, late, cancelled, ship };
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
  const { crates, hotel, late, cancelled, ship } = await seed(context.request);
  const { A, C: c, K, E, F, G } = crates as Record<'A' | 'C' | 'K' | 'E' | 'F' | 'G', Crate>;
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
    // G1 too (G allocated to an order that is cancelled later).
    const g1 = await json<{ outcome: string; code: string; issue: { code: string } }>(
      await post(`/receipts/${open.code}/lines/${box}/bottles`, {
        scannedValue: G.bottles[0],
        outcome: 'GOOD',
      }),
    );
    expect(g1).toMatchObject({ outcome: 'ISSUE_RECORDED', code: 'NOT_DELIVERED' });
    legacy.g1Issue = g1.issue.code;
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
  // F is freed while F1 still has its OLD unanchored NOT_DELIVERED (the finding of the first run,
  // fixed by #208): F1 is refused here and the old issue names it.
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

  // "Dořešit" on the old receipt: F1 counted once, in F's delivered cycle, on the old line.
  await page.goto(`/production/cycle/returns/${legacy.open}`);
  await identify(F.bottles[0]!);
  await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  const f1 = `(SELECT "id" FROM "bottles" WHERE "public_token" = '${F.bottles[0]!.split('/').pop()}')`;
  const sortedF1 = async () =>
    e2eRows<{ crate: string; receipt: string }>(
      `SELECT cr."code" AS crate, r."code" AS receipt FROM "bottle_events" e
         JOIN "crate_cycles" c ON c."id" = e."crate_cycle_id"
         JOIN "crates" cr ON cr."id" = c."crate_id"
         JOIN "return_receipt_lines" l ON l."id" = e."return_line_id"
         JOIN "return_receipts" r ON r."id" = l."receipt_id"
        WHERE e."bottle_id" = ${f1} AND e."type" = 'SORTED'`,
    );
  const once = await sortedF1();
  expect(once).toHaveLength(1);
  expect(once[0]).toEqual({ crate: F.code, receipt: legacy.open });
  await step(page, 'old-r1-f1-identified-after-crate-freed', once);
  // A rescan in the new receipt never counts it again; nothing is written.
  await page.goto(`/production/cycle/returns/${eReceipt}`);
  const beforeRescan = await detector();
  await scanBottle(page, F.bottles[0]!);
  await expect(message(page)).toContainText('Lahev už byla přijata v jiném příjmu');
  await expect(page.getByTestId('receipt-counts')).toHaveText(
    'Bedny 2 · přijaté lahve 18 (z toho ke skartaci 0) · nečitelné 0',
  );
  expect(await detector()).toEqual(beforeRescan);
  expect(await sortedF1()).toEqual(once);
  await step(page, 'f1-rescan-not-counted');

  // --- 3. G1: the bottle provably started another circulation -------------------------------
  // G's first order is cancelled; G goes out with a later order and is delivered (P1: unloaded,
  // then a new receipt).
  await json(
    await context.request.post(`/api/admin/orders/${cancelled}/cancel`, {
      data: { requestId: crypto.randomUUID(), reason: 'Zkouška: storno před vyzvednutím' },
    }),
  );
  const again = await ship([G]);
  await carrier(context.request, again, true);
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).not.toHaveURL(new RegExp(`(${kReceipt}|${eReceipt})$`));
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  const gReceipt = page.url().split('/').pop()!;
  await scanCrate(page, G.url);
  await expect(message(page)).toContainText(`Bedna ${G.code} přijata a uvolněna`);
  for (const u of G.bottles.slice(1)) {
    await scanBottle(page, u);
    await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  }
  // The old issue does not take over G's later circulation: nothing written.
  await page.goto(`/production/cycle/returns/${legacy.open}`);
  const beforeG = await detector();
  await identify(G.bottles[0]!);
  await expect(message(page)).toContainText(
    'Lahev je už v dalším oběhu, než který neshoda zaznamenala – neshoda zůstává otevřená.',
  );
  expect(await detector()).toEqual(beforeG);
  const g1 = `(SELECT "id" FROM "bottles" WHERE "public_token" = '${G.bottles[0]!.split('/').pop()}')`;
  const sortedG1 = () =>
    e2eRows<{ n: bigint }>(
      `SELECT count(*) AS n FROM "bottle_events" WHERE "bottle_id" = ${g1} AND "type" = 'SORTED'`,
    );
  expect(Number((await sortedG1())[0]!.n)).toBe(0);
  await step(page, 'g1-old-issue-refused-circulation-changed');
  // The new receipt names the open issue; a supervisor closes it out; then G1 is counted once.
  await page.goto(`/production/cycle/returns/${gReceipt}`);
  await scanBottle(page, G.bottles[0]!);
  await expect(message(page)).toContainText(
    'Lahev má otevřenou neshodu – dořešte ji u té neshody.',
  );
  await json(
    await context.request.post(`/api/admin/returns/issues/${legacy.g1Issue}/close-out`, {
      data: {
        requestId: crypto.randomUUID(),
        resolution: 'WRITTEN_OFF',
        reason: 'Zkouška: lahev v pozdějším oběhu, stará neshoda nedoložena',
      },
    }),
  );
  await scanBottle(page, G.bottles[0]!);
  await expect(message(page)).toContainText('Vrácená, čeká na mytí');
  await scanBottle(page, G.bottles[0]!);
  await expect(page.getByTestId('receipt-counts')).toHaveText(
    'Bedny 1 · přijaté lahve 10 (z toho ke skartaci 0) · nečitelné 0',
  );
  expect(Number((await sortedG1())[0]!.n)).toBe(1);
  await step(page, 'g1-counted-once-in-new-circulation');

  await page.goto(`/production/cycle/returns/${legacy.open}`);
  // The old R1 lines emptied with a count (the migration plan), then closed.
  for (const [testId, count] of [
    [`return-line-${c.code}`, '1'],
    ['return-line-box-2', '3'],
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

  // Every bottle once: A 10 and C1 (R1), K 8, E 10, F 10, G 10 — 2 of K at the hotel.
  const counted = await e2eRows<{ n: bigint }>(
    `SELECT count(DISTINCT b."id") AS n FROM "bottles" b WHERE b."status" = 'RETURNED'`,
  );
  await page.goto('/production/cycle/returns');
  await step(page, 'overview', {
    receipts: { ...legacy, k: kReceipt, ef: eReceipt, g: gReceipt },
    returnedBottles: Number(counted[0]!.n),
  });
  expect(Number(counted[0]!.n)).toBe(10 + 1 + 8 + 10 + 10 + 10);
  await context.close();
});
