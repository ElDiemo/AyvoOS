import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { labelingSetup, newCrate } from './labeling-setup';

/**
 * Issue #11 follow-up (UI-20…24, UI-08): Výroba is split into sections — Přehled, Práce,
 * Evidence, Nastavení výroby — and shows only the active section's pages; a plain production
 * operator sees Práce and Evidence only; "Připravit výrobu" names the concrete next step (only
 * with the permission it needs); preparing QR identities says what it is not; the crate list
 * starts with crates on a phone; supervised corrections are a separate, collapsed section.
 * Permissions and production rules are unchanged. Screenshots go to AYVO_SCREENSHOT_DIR.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: '390', width: 390, height: 844 },
  { name: '320', width: 320, height: 740 },
];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

async function operator(browser: Browser, admin: Page) {
  const me = (await (await admin.request.get('/api/auth/me')).json()) as {
    sites: { id: string; code: string }[];
  };
  const site = me.sites.find((s) => s.code === 'CZ-PREROV-01')!;
  const email = `e2e-plain-operator-${Date.now()}@ayvo.test`;
  const res = await admin.request.post('/api/admin/identity/users', {
    data: {
      email,
      displayName: 'Operátor výroby',
      roles: ['PRODUCTION_OPERATOR'],
      siteIds: [site.id],
      warehouseCodes: [],
      reason: 'UI clarity test',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/api/auth/login?next=/production&login_hint=${email}`);
  await expect(page.getByTestId('current-user')).toBeVisible();
  return { context, page };
}

let productCode = '';
let crateCode = '';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  // A product with an active recipe whose design is not approved yet (synthetic).
  const kit = await labelingSetup(context.request, { versionId: '', approve: false });
  productCode = kit.productCode;
  crateCode = (await newCrate(context.request, kit.crateTypeCode)).code;
  await context.close();
});

for (const w of WIDTHS) {
  test(`sections instead of one long strip — ${w.name}`, async ({ page }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto('/production');
    const nav = page.getByRole('navigation', { name: 'Výroba' });
    for (const s of ['overview', 'work', 'records', 'setup']) {
      await expect(nav.getByTestId(`section-${s}`)).toBeInViewport({ ratio: 1 });
    }
    await expect(nav.getByTestId('module-tabs')).toHaveCount(0); // no pages of other sections
    await shot(page, `ui11-01-production-${w.name}`);
    await nav.getByTestId('section-setup').click();
    await expect(page).toHaveURL(/\/production\/setup$/);
    await expect(nav.getByTestId('section-setup')).toHaveAttribute('aria-current', 'true');
    await expect(nav.getByTestId('module-tabs').getByRole('link')).toHaveCount(4);
    await noOverflow(page);
    // A narrower window keeps the active page in view (UI-08 follow-up).
    await page.goto('/label-templates');
    await page.setViewportSize({ width: 320, height: 740 });
    const strip = nav.getByTestId('module-tabs');
    const active = strip.locator('[aria-current="page"]');
    await expect
      .poll(async () => {
        const s = (await strip.boundingBox())!;
        const a = (await active.boundingBox())!;
        return a.x >= s.x - 1 && a.x + a.width <= s.x + s.width + 1;
      })
      .toBe(true);
  });
}

test('a plain production operator sees Práce and Evidence, not the setup', async ({
  browser,
  page,
}) => {
  const { context, page: op } = await operator(browser, page);
  await op.setViewportSize({ width: 390, height: 844 });
  await op.goto('/production/station');
  const nav = op.getByRole('navigation', { name: 'Výroba' });
  await expect(nav.getByTestId('module-sections').getByRole('link')).toHaveText([
    /^Přehled/,
    /^Práce/,
    /^Evidence/,
  ]);
  await expect(nav.getByTestId('section-setup')).toHaveCount(0);
  await expect(nav.getByTestId('section-work')).toHaveAttribute('aria-current', 'true');
  // A clear way in: scan the station's QR, or ask the supervisor.
  await expect(op.getByTestId('station-hint')).toContainText('Požádejte vedoucího');
  await expect(op.getByLabel('Naskenujte QR pracoviště')).toBeFocused();
  await shot(op, 'ui11-02-operator-station-390');
  await nav.getByTestId('section-records').click();
  await expect(nav.getByTestId('module-tabs').getByRole('link')).toContainText(['Bedny', 'Lahve']);
  // The setup overview stays with the supervisors (existing permissions).
  await op.goto('/production/setup');
  await expect(op.getByRole('heading', { level: 1 })).not.toHaveText('Připravit výrobu');
  await context.close();
});

for (const w of WIDTHS) {
  test(`Připravit výrobu names the concrete next step — ${w.name}`, async ({ page }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto(`/production/setup?product=${productCode}`);
    const design = page.getByTestId('step-setup.design');
    await expect(design.getByRole('link')).toHaveText(
      'Další krok: Schválit design etikety pro tento produkt →',
    );
    // Labels wait for the design: explained, with the step to prepare them.
    const labels = page.getByTestId('step-labeling.labels');
    await expect(labels).toContainText('nejdřív schvalte design etikety');
    await expect(labels.getByRole('link')).toHaveAttribute('href', '/bottles/new');
    await expect(page.getByTestId('step-filling.crates')).toContainText('vznikají lepením');
    await noOverflow(page);
    await shot(page, `ui11-03-setup-${w.name}`);
    if (w.name === 'desktop') {
      await design.getByRole('link').click();
      await expect(page).toHaveURL(
        new RegExp(`/production/catalog/products/${productCode}#designs$`),
      );
      await expect(page.locator('#designs')).toBeInViewport();
    }
  });
}

for (const w of WIDTHS) {
  test(`QR identities are not physical bottles — ${w.name}`, async ({ page }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto('/bottles/new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Připravit QR etikety lahví');
    await expect(page.getByText('Nic se neodepisuje ze skladu')).toBeVisible();
    const steps = page.getByTestId('bottle-steps');
    await expect(steps).toContainText('QR identita a PDF etikety');
    await expect(steps).toContainText('Nalepení etikety');
    await expect(steps).toContainText('Naplnění');
    await noOverflow(page);
    await shot(page, `ui11-04-bottles-new-${w.name}`);
  });
}

for (const w of WIDTHS) {
  test(`crate list and detail: crates first, corrections set apart — ${w.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto('/production/crates');
    // On a phone the first crate starts within the first screen.
    await expect(page.getByTestId('crates').locator('li').first()).toBeInViewport();
    await expect(page.getByTestId('crate-more-filters')).not.toHaveAttribute('open', '');
    await noOverflow(page);
    await shot(page, `ui11-05-crates-${w.name}`);
    await page.goto(`/production/crates/${crateCode}`);
    const section = page.getByTestId('crate-corrections-section');
    await expect(section).toContainText('Opravy vedoucího');
    await expect(page.getByTestId('crate-corrections')).toBeHidden();
    // Identity, content, QR printing and history come before the corrections.
    const order = await page.evaluate(() =>
      ['crate-content-card', 'crate-facts', 'crate-history', 'crate-corrections-section'].map(
        (id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top,
      ),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await noOverflow(page);
    await shot(page, `ui11-06-crate-detail-${w.name}`);
  });
}
