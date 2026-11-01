import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Which web and Finance builds work together, on one migrated database: this build and a real earlier
 * build, started as processes, in the order of an upgrade and of a return. Synthetic data, nothing
 * outside this machine. Writes what each page did to AYVO_COMPAT_REPORT.
 */
const OLD_ROOT = process.env.AYVO_COMPAT_OLD_ROOT!;
const REPORT = process.env.AYVO_COMPAT_REPORT ?? join(tmpdir(), 'ayvo-compat-report.json');
const SHOTS = process.env.AYVO_COMPAT_SHOTS;
const FINANCE = 'http://localhost:4110';
const OLD_WEB = 'http://localhost:3200';
const NEW_WEB = 'http://localhost:3100';
const serverPid = () =>
  Number(readFileSync(join(tmpdir(), 'ayvo-e2e-server-4100.pid'), 'utf8').trim());
/** As `docker stop`: the test server's Finance gets 5 s, then is killed (it can keep answering for 40 s). */
function stopTestFinance() {
  const pid = execFileSync('pgrep', ['-P', String(serverPid())], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .find((p) => readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('dist/finance/main.js'));
  process.kill(serverPid(), 'SIGUSR2');
  setTimeout(() => {
    try {
      if (pid) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }, 5_000).unref();
}

const report: Record<string, Record<string, string>> = {};
let oldFinance: ChildProcess | null = null;
let oldWeb: ChildProcess | null = null;
let financeEnv: NodeJS.ProcessEnv = {};

const financeUp = async () =>
  (await fetch(`${FINANCE}/api/health`).catch(() => null))?.status === 200 ||
  (await fetch(`${FINANCE}/api/admin/finance/health/ready`).catch(() => null))?.status === 200;
const waitFinance = (up: boolean) => expect.poll(financeUp, { timeout: 40_000 }).toBe(up);

function readFinanceEnv() {
  const children = execFileSync('pgrep', ['-P', String(serverPid())], { encoding: 'utf8' })
    .trim()
    .split('\n');
  for (const pid of children) {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('dist/finance/main.js')) continue;
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
  }
  throw new Error('Finance process not found');
}
async function useOldFinance() {
  financeEnv = readFinanceEnv();
  stopTestFinance();
  await waitFinance(false);
  oldFinance = spawn(process.execPath, ['dist/finance/main.js'], {
    cwd: resolve(OLD_ROOT, 'apps/api'),
    env: financeEnv,
    stdio: 'ignore',
  });
  await waitFinance(true);
}
async function useNewFinance() {
  // As `docker stop`: a grace period, then killed (open connections can hold a graceful stop).
  const stopping = oldFinance;
  stopping?.kill('SIGTERM');
  setTimeout(() => stopping?.kill('SIGKILL'), 5_000).unref();
  oldFinance = null;
  await waitFinance(false);
  process.kill(serverPid(), 'SIGUSR1');
  await waitFinance(true);
}
async function startOldWeb() {
  oldWeb = spawn(
    resolve(OLD_ROOT, 'apps/web/node_modules/.bin/next'),
    ['start', '--port', '3200'],
    {
      cwd: resolve(OLD_ROOT, 'apps/web'),
      env: {
        ...process.env,
        API_URL: 'http://localhost:4100',
        FINANCE_API_URL: FINANCE,
      },
      stdio: 'ignore',
    },
  );
  await expect
    .poll(async () => (await fetch(OLD_WEB).catch(() => null))?.status ?? 0, { timeout: 40_000 })
    .toBeGreaterThan(0);
}

/** What a person gets on a page: the status, and an error page rather than the content. */
async function look(page: Page, url: string, state: string, name: string, testId?: string) {
  const res = await page.goto(url);
  await page.waitForLoadState('networkidle');
  const body = await page.locator('body').innerText();
  const crashed = (res?.status() ?? 0) >= 500;
  const mismatch = (await page.getByTestId('finance-version-mismatch').count()) > 0;
  const notFound = res?.status() === 404 || /nebyla nalezena|404/i.test(body.slice(0, 400));
  const content = testId ? (await page.getByTestId(testId).count()) > 0 : true;
  const outcome = mismatch
    ? 'NESOULAD VERZÍ (srozumitelná stránka)'
    : crashed
      ? `CHYBOVÁ STRÁNKA (${res?.status()})`
      : notFound
        ? `NENALEZENO (${res?.status()})`
        : content
          ? `OK (${res?.status()})`
          : `BEZ OBSAHU (${res?.status()})`;
  (report[state] ??= {})[name] = outcome;
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${state}--${name}.png`), fullPage: true });
  return outcome;
}
const json = async <T>(res: Awaited<ReturnType<APIRequestContext['get']>>) => {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
};

test('upgrade and return: old and new web and Finance on one migrated database', async ({
  page,
}) => {
  const r = page.request;
  const run = crypto.randomUUID().slice(0, 6).toUpperCase();
  const me = await json<{ sites: { id: string; code: string }[] }>(
    await r.get(`${NEW_WEB}/api/auth/me`),
  );
  const hotel = await json<{ code: string }>(
    await r.post(`${NEW_WEB}/api/admin/hotels`, {
      data: {
        requestId: crypto.randomUUID(),
        name: `Hotel Návrat ${run}`,
        addressLine1: 'Ukázková 1',
        addressLine2: null,
        postalCode: '602 00',
        city: 'Brno',
        countryCode: 'CZ',
        contactName: 'Recepce',
        contactPhone: '+420 500 000 045',
        contactEmail: 'recepce@navrat.test',
        fulfillmentSiteId: me.sites[0]!.id,
      },
    }),
  );
  const customerData = {
    legalName: `Návrat ${run} s.r.o.`,
    companyId: null,
    vatId: null,
    addressLine1: 'Ukázková 1',
    addressLine2: null,
    postalCode: '602 00',
    city: 'Brno',
    countryCode: 'CZ',
    billingEmail: 'fakturace@navrat.test',
    documentLanguage: 'cs',
  };
  const customer = await json<{ id: string; code: string }>(
    await r.post(`${NEW_WEB}/api/admin/finance/billing/customers`, {
      data: { requestId: crypto.randomUUID(), customer: customerData },
    }),
  );
  const hotels = await json<{ id: string; code: string }[]>(
    await r.get(`${NEW_WEB}/api/admin/finance/billing/hotels`),
  );
  const agreement = await json<{ code: string }>(
    await r.post(`${NEW_WEB}/api/admin/finance/billing/agreements`, {
      data: {
        requestId: crypto.randomUUID(),
        hotelId: hotels.find((h) => h.code === hotel.code)!.id,
        terms: {
          effectiveFrom: '2026-01',
          customerId: customer.id,
          contractNumber: null,
          billedRooms: 10,
          ownPricePerRoomMonth: '400.00',
          currency: 'CZK',
          paymentTermsDays: 14,
          billingTiming: 'ARREARS',
          validFrom: '2026-01-01',
          validTo: null,
          reason: 'Smlouva (syntetická)',
        },
      },
    }),
  );
  const effective = await json<{
    items: {
      agreement: { code: string };
      version: { revision: number; billedRooms: number };
      customer: { version: number };
      price: { perRoomMonth: string; priceListVersionId: string | null };
    }[];
  }>(await r.get(`${NEW_WEB}/api/admin/finance/billing/agreements/effective?month=2026-06`));
  const t = effective.items.find((i) => i.agreement.code === agreement.code)!;
  const invoice = await json<{ number: string; total: string; variableSymbol: string }>(
    await r.post(`${NEW_WEB}/api/admin/finance/invoices/test`, {
      data: {
        requestId: crypto.randomUUID(),
        month: '2026-06',
        lines: [
          {
            agreementCode: agreement.code,
            agreementRevision: t.version.revision,
            customerVersion: t.customer.version,
            priceListVersionId: t.price.priceListVersionId,
            unitPrice: t.price.perRoomMonth,
            billedRooms: t.version.billedRooms,
          },
        ],
      },
    }),
  );
  await json(
    await r.post(`${NEW_WEB}/api/admin/finance/payments/simulate`, {
      data: {
        requestId: crypto.randomUUID(),
        entries: [
          {
            reference: `NAVRAT-${run}`,
            amount: invoice.total,
            currency: 'CZK',
            variableSymbol: invoice.variableSymbol,
            bookedOn: '2026-06-20',
            counterpartyName: `Návrat ${run}`,
            message: null,
          },
        ],
      },
    }),
  );
  const payments = await json<{ payments: { code: string }[] }>(
    await r.get(`${NEW_WEB}/api/admin/finance/payments?q=${encodeURIComponent(`Návrat ${run}`)}`),
  );
  const payment = payments.payments[0]!.code;
  const newPdf = await (
    await r.get(`${NEW_WEB}/api/admin/finance/invoices/${invoice.number}/pdf`)
  ).body();

  const pages = async (web: string, state: string) => {
    await look(page, `${web}/finance/payments`, state, 'platby', 'payments');
    await look(page, `${web}/finance/invoices`, state, 'faktury', 'invoices');
    await look(page, `${web}/finance/invoices/${invoice.number}`, state, 'detail-faktury');
    await look(page, `${web}/finance/billing`, state, 'smlouvy');
    await look(page, `${web}/finance/billing/customers/${customer.code}`, state, 'platce');
    await look(page, `${web}/hotels/${hotel.code}`, state, 'hotel');
    await look(page, `${web}/finance`, state, 'prehled');
  };
  /** The old and the new customer form both write through what this Finance accepts. */
  const oldCustomerWrite = async (label: string) =>
    r.post(`${NEW_WEB}/api/admin/finance/billing/customers`, {
      data: {
        requestId: crypto.randomUUID(),
        customer: {
          legalName: `${label} ${run} s.r.o.`,
          companyId: null,
          vatId: null,
          addressLine1: 'Ukázková 1',
          addressLine2: null,
          postalCode: '602 00',
          city: 'Brno',
          countryCode: 'CZ',
          billingEmail: 'stara@navrat.test',
        },
      },
    });

  /** The old form of the old web, as a person uses it; what it says afterwards. */
  const oldForm = async (name: string) => {
    // The API admits one origin, the new web's here; in production both builds have the same origin.
    await page.route(`${OLD_WEB}/api/**`, async (route) =>
      route.fulfill({
        response: await route.fetch({
          headers: { ...route.request().headers(), origin: NEW_WEB },
        }),
      }),
    );
    await page.goto(`${OLD_WEB}/finance/billing`);
    await page.getByTestId('customer-new-open').click();
    const form = page.getByTestId('customer-new');
    await form.locator('[name=legalName]').fill(`${name} ${run} s.r.o.`);
    await form.locator('[name=addressLine1]').fill('Ukázková 1');
    await form.locator('[name=postalCode]').fill('602 00');
    await form.locator('[name=city]').fill('Brno');
    await form.locator('[name=billingEmail]').fill('stara@navrat.test');
    await form.getByTestId('customer-save').click();
    await expect(form.locator('[role=status], [role=alert]').first()).toBeVisible();
    return (await form.locator('[role=status], [role=alert]').first().innerText()).trim();
  };

  try {
    await startOldWeb();
    await pages(NEW_WEB, 'A-novy-web+nova-Finance');

    // Finance alone returns: new web, old Finance.
    await useOldFinance();
    await pages(NEW_WEB, 'B-novy-web+stara-Finance');
    await look(
      page,
      `${NEW_WEB}/finance/payments/${payment}`,
      'B-novy-web+stara-Finance',
      'detail-platby',
    );
    await page.goto(`${NEW_WEB}/finance/payments?filter=REVIEW&q=x`);
    (report['B-novy-web+stara-Finance'] ??= {})['platby-legacy-poznamka'] =
      (await page.getByTestId('payments-legacy').count()) > 0 ? 'ANO' : 'NE';
    report['B-novy-web+stara-Finance']!['platby-akce-skryte'] =
      (await page.getByTestId('import-bank').count()) +
        (await page.getByTestId('payments-simulation').count()) ===
      0
        ? 'ANO'
        : 'NE';
    report['B-novy-web+stara-Finance']!['platby-filtry-skryte'] =
      (await page.getByTestId('payments-filters').count()) === 0 ? 'ANO' : 'NE';
    report['B-novy-web+stara-Finance']!['platby-otevreni-detailu-nabizeno'] =
      (await page.getByTestId(`payment-${payment}-open`).count()) > 0 ? 'ANO' : 'NE';

    // Both returned: old web, old Finance, on the migrated database.
    await pages(OLD_WEB, 'C-stary-web+stara-Finance');
    report['C-stary-web+stara-Finance']!['stary-formular-platce'] = await oldForm('Formulář starý');
    const written = await oldCustomerWrite('Starý obraz');
    report['C-stary-web+stara-Finance']!['zapis-platce-bez-jazyka'] = String(written.status());
    expect(written.ok()).toBe(true);
    const old = (await written.json()) as { code: string };
    const oldPdf = await (
      await r.get(`${NEW_WEB}/api/admin/finance/invoices/${invoice.number}/pdf`)
    ).body();
    report['C-stary-web+stara-Finance']!['pdf-beze-zmeny'] = oldPdf.equals(newPdf) ? 'ANO' : 'NE';

    // Upgrade again: Finance first, the old web still running against it.
    await useNewFinance();
    await pages(OLD_WEB, 'D-stary-web+nova-Finance');
    report['D-stary-web+nova-Finance']!['stary-formular-platce'] =
      await oldForm('Formulář odmítnutý');
    const refused = await oldCustomerWrite('Bez jazyka');
    report['D-stary-web+nova-Finance']!['zapis-platce-bez-jazyka'] = String(refused.status());

    // Finished upgrade: what the old image wrote is a blocker, not a guess; a person chooses.
    await pages(NEW_WEB, 'E-novy-web+nova-Finance-po-navratu');
    const written2 = await json<{
      current: { version: number; customer: Record<string, unknown> };
    }>(await r.get(`${NEW_WEB}/api/admin/finance/billing/customers/${old.code}`));
    report['E-novy-web+nova-Finance-po-navratu']!['jazyk-platce-ze-stareho-obrazu'] = String(
      written2.current.customer.documentLanguage,
    );
    const chosen = await r.post(
      `${NEW_WEB}/api/admin/finance/billing/customers/${old.code}/versions`,
      {
        data: {
          requestId: crypto.randomUUID(),
          expectedVersion: written2.current.version,
          customer: { ...written2.current.customer, documentLanguage: 'en' },
          reason: 'Výběr jazyka (test)',
        },
      },
    );
    report['E-novy-web+nova-Finance-po-navratu']!['vyber-jazyka'] = String(chosen.status());
    await page.goto(`${NEW_WEB}/finance/payments`);
    report['E-novy-web+nova-Finance-po-navratu']!['platby-legacy-poznamka'] =
      (await page.getByTestId('payments-legacy').count()) > 0 ? 'ANO' : 'NE';

    // A second return after the finished upgrade, and the way forward again.
    await useOldFinance();
    await look(
      page,
      `${NEW_WEB}/finance/payments`,
      'F-druhy-navrat-stara-Finance',
      'platby',
      'payments',
    );
    await useNewFinance();
    await look(
      page,
      `${NEW_WEB}/finance/payments/${payment}`,
      'G-znovu-nova-Finance',
      'detail-platby',
    );

    // What is supported and what is said openly when it is not.
    const B = report['B-novy-web+stara-Finance']!;
    expect(B.platby).toMatch(/^OK/);
    expect(B['platby-legacy-poznamka']).toBe('ANO');
    expect(B['platby-otevreni-detailu-nabizeno']).toBe('NE');
    expect(B.hotel).toMatch(/^OK/);
    for (const name of ['faktury', 'detail-faktury', 'platce'])
      expect(B[name], name).toMatch(/^NESOULAD/);
    expect(
      Object.values(report['C-stary-web+stara-Finance']!).filter((v) => /^CHYB|^NES/.test(v)),
    ).toEqual([]);
    expect(report['C-stary-web+stara-Finance']!['pdf-beze-zmeny']).toBe('ANO');
    expect(report['D-stary-web+nova-Finance']!['zapis-platce-bez-jazyka']).toBe('400');
    const E = report['E-novy-web+nova-Finance-po-navratu']!;
    expect(E['jazyk-platce-ze-stareho-obrazu']).toBe('null');
    expect(E['vyber-jazyka']).toBe('201');
    expect(E['platby-legacy-poznamka']).toBe('NE');
    expect(report['G-znovu-nova-Finance']!['detail-platby']).toMatch(/^OK/);
  } finally {
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    oldWeb?.kill('SIGTERM');
    oldFinance?.kill('SIGTERM');
  }
});
