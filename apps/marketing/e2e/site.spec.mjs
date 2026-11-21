// The marketing site in a real browser (ADR 0040), served by its real image: every language at
// 1440 / 390 / 320 px without horizontal scrolling, every request to the site itself (no
// tracking, fonts or CDNs), no CSP or console errors, images and favicon loaded, the language
// switch keeping the section being read, the CTAs, and a real 404. Screenshots for review.
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { withoutExpected } from './console-errors.mjs';

const PAGES = [
  { path: '/', lang: 'en', code: 'en' },
  { path: '/cz/', lang: 'cs', code: 'cz' },
  { path: '/de/', lang: 'de', code: 'de' },
];
const WIDTHS = [1440, 390, 320];
const SHOTS = resolve(import.meta.dirname, '../../../docs/screenshots/marketing');
const run = JSON.parse(process.env.AYVO_MARKETING_E2E_RUN);
const SELF = `127.0.0.1:${run.port}`;
/** Chrome's console line for a document that answers 404. */
const DOCUMENT_404 =
  'Failed to load resource: the server responded with a status of 404 (Not Found)';

/** Opens a page and records every request and every console/page error. */
async function open(page, path) {
  const foreign = [];
  const failed = [];
  const errors = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.host !== SELF && url.protocol !== 'data:') foreign.push(r.url());
  });
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push({ text: m.text(), url: m.location().url }),
  );
  page.on('pageerror', (e) => errors.push({ text: String(e), url: null }));
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  return { res, foreign, failed, errors };
}

for (const width of WIDTHS) {
  for (const p of PAGES) {
    test(`${p.path} at ${width}px: content, images, no foreign requests, no horizontal scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const { res, foreign, failed, errors } = await open(page, p.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
      await expect(page.locator('html')).toHaveAttribute('lang', p.lang);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator(`a[aria-current="page"][href="${p.path}"]`).first()).toBeVisible();

      // Lazy images: scroll through, then every image is decoded.
      for (const img of await page.locator('img').all()) await img.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          page.$$eval('img', (imgs) =>
            imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src),
          ),
        )
        .toEqual([]);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The favicon and the touch icon resolve.
      for (const href of await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (l) =>
        l.map((x) => x.getAttribute('href')),
      )) {
        const icon = await page.request.get(href);
        expect(icon.status(), href).toBe(200);
        expect(icon.headers()['content-type']).toBe('image/png');
      }

      expect(foreign).toEqual([]);
      expect(failed).toEqual([]);
      expect(errors).toEqual([]);

      if (width !== 320) {
        mkdirSync(SHOTS, { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `${SHOTS}/marketing-${p.code}-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        });
      }
    });
  }
}

test('the hero: one scene from edge to edge, the bottles on the counter, the offer and CTA first on phones', async ({
  page,
}) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await open(page, '/');
    const visual = page.locator('#top img.ayvo-hero-visual');
    await expect(visual).toBeVisible();
    // The two real bottles as one transparent layer, never rescaled in the file.
    expect(await visual.evaluate((i) => [i.naturalWidth, i.naturalHeight])).toEqual([474, 612]);
    const hero = await page.locator('#top').boundingBox();
    const stage = await page.locator('#top .ayvo-hero-stage').boundingBox();
    const img = await visual.boundingBox();
    const h1 = await page.locator('#top h1').boundingBox();
    const cta = await page.locator('#top a[href="#pilot"]').boundingBox();
    // The background layer reaches both edges of the hero.
    expect(Math.abs(stage.x - hero.x)).toBeLessThan(1);
    expect(Math.abs(stage.width - hero.width)).toBeLessThan(1);
    // The bottles stand on the counter (its back edge at 78 % of the scene, the bases just in front).
    const base = (img.y + img.height - stage.y) / stage.height;
    expect(base).toBeGreaterThan(0.78);
    expect(base).toBeLessThan(0.86);
    if (width === 1440) {
      expect(Math.abs(stage.height - hero.height)).toBeLessThan(1);
      expect(img.x).toBeGreaterThan(h1.x + h1.width);
    } else {
      // Phones: the offer and the CTA first (in the first screen), then the scene with the bottles.
      expect(cta.y + cta.height).toBeLessThanOrEqual(844);
      expect(stage.y).toBeGreaterThanOrEqual(cta.y + cta.height);
      expect(img.y).toBeLessThan(844);
    }
  }
  for (const file of ['ayvo-hero-products.webp', 'ayvo-hero-background.webp']) {
    const res = await page.request.get(`/assets/img/${file}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/webp');
  }
  await page.locator('#top a[href="#pilot"]').click();
  await expect(page).toHaveURL(/#pilot$/);
  await expect(page.locator('#pilot h2')).toBeInViewport();
  const mail = page.locator('#pilot a[href^="mailto:"]');
  await expect(mail).toHaveAttribute('href', /^mailto:hello@ayvo\.co\?subject=/);
});

test('narrow desktops (861 / 900 / 1024 px): the copy never reaches the bottle layer', async ({
  page,
}) => {
  for (const width of [861, 900, 1024]) {
    for (const p of PAGES) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, p.path);
      const { text, product } = await page.evaluate(() => {
        // The real extents of the text (its line boxes), not the blocks around it.
        const right = (el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return Math.max(...[...range.getClientRects()].map((r) => r.right));
        };
        const copy = [
          ...document.querySelectorAll(
            '#top h1 .ayvo-h1-part, #top .ayvo-hero-points li, #top .ayvo-hero-slogan',
          ),
        ];
        const cta = document.querySelector('#top a[href="#pilot"]').getBoundingClientRect().right;
        return {
          text: Math.max(cta, ...copy.map(right)),
          product: document.querySelector('#top img.ayvo-hero-visual').getBoundingClientRect().left,
        };
      });
      expect(text, `${p.path} at ${width}px`).toBeLessThan(product);
    }
  }
});

test('the header: compact (52-64 px), one line from 320 px, the logo links home, 40 px language targets', async ({
  page,
}) => {
  for (const width of [320, 390, 861, 1440]) {
    for (const p of [...PAGES, { path: '/no-such-page', lang: 'en' }]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(p.path);
      const header = await page.locator('header.ayvo-header').boundingBox();
      expect(header.height, `${p.path} at ${width}px`).toBeGreaterThanOrEqual(52);
      expect(header.height, `${p.path} at ${width}px`).toBeLessThanOrEqual(64);
      const brand = page.locator('header a.ayvo-brand');
      await expect(brand).toHaveAttribute('href', p.path === '/no-such-page' ? '/' : p.path);
      const logo = await brand.boundingBox();
      // One line: everything inside the header's height, side by side.
      expect(logo.y).toBeGreaterThanOrEqual(header.y);
      expect(logo.y + logo.height).toBeLessThanOrEqual(header.y + header.height);
      for (const lang of await page.locator('header a.ayvo-lang').all()) {
        const box = await lang.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(40);
        expect(box.height).toBeGreaterThanOrEqual(40);
        expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
        expect(box.x).toBeGreaterThan(logo.x + logo.width);
      }
    }
  }
  await page.goto('/cz/');
  const current = page.locator('header a.ayvo-lang[aria-current="page"]');
  await expect(current).toHaveText('CZ');
  expect(await current.evaluate((a) => getComputedStyle(a).fontWeight)).toBe('700');
});

test('switching the language keeps the section being read', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/');
  await page.evaluate(() => document.querySelector('#how').scrollIntoView({ behavior: 'instant' }));
  await page.locator('header a[href="/de/"]').click();
  await expect(page).toHaveURL(/\/de\/#how$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#how h2')).toBeInViewport();

  // At the top of the page the switch goes to the top of the other language.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('header a[href="/cz/"]').click();
  await expect(page).toHaveURL(/\/cz\/$/);
});

test('the skip link moves the focus to the content', async ({ page }) => {
  await open(page, '/cz/');
  await page.keyboard.press('Tab');
  const skip = page.locator('a.ayvo-skip');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await expect(skip).toHaveText('Přeskočit na obsah');
});

test('an unknown address is a real 404 page with the way back; old addresses redirect', async ({
  page,
}) => {
  const { res, errors } = await open(page, '/no-such-page');
  expect(res.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('Page not found');
  // Chrome reports the 404 of the document itself — only that line, at that URL, is expected.
  const rest = withoutExpected(errors, { text: DOCUMENT_404, url: `http://${SELF}/no-such-page` });
  expect(errors.length - rest.length).toBe(1);
  expect(rest).toEqual([]);
  await page.locator('a[href="/de/"]').click();
  await expect(page).toHaveURL(/\/de\/$/);

  const en = await page.goto('/en/');
  expect(en.url()).toBe(`http://${SELF}/`);
  const img = await page.request.get('/wp-content/uploads/2026/02/Navrh-bez-nazvu-6.png');
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toBe('image/png');
});
