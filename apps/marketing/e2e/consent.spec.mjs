// Opt-in website analytics (Google Analytics 4, ADR 0040 amendment) in a real browser against the
// real image. Nothing ever reaches Google: every request that leaves the test container is caught;
// the Google tag and its transport are mocks. Two variants:
// - the test host (as the DEV preview): the choice works, but Google is never loaded;
// - the public hostname (ayvo.co mapped to the test container in an isolated browser): nothing
//   before the choice or after "Decline"/withdrawal, exactly one tag with the right ID after it.
import { expect, test } from '@playwright/test';

// An isolated browser for this file: the public name ayvo.co resolves to the test container
// (only in this browser), so the public-hostname variant is tested without the real site.
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP ayvo.co 127.0.0.1'] } });

const ID = 'G-W8X01GWW5Z';
const run = JSON.parse(process.env.AYVO_MARKETING_E2E_RUN);
const SELF = `127.0.0.1:${run.port}`;
const PUBLIC = `ayvo.co:${run.port}`;
const TEST_URL = `http://${SELF}`;
const PUBLIC_URL = `http://${PUBLIC}`;
const PAGES = [
  { path: '/', allow: 'Allow analytics', deny: 'Decline', open: 'Analytics settings' },
  { path: '/cz/', allow: 'Povolit analytiku', deny: 'Odmítnout', open: 'Nastavení analytiky' },
  { path: '/de/', allow: 'Analyse erlauben', deny: 'Ablehnen', open: 'Analyse-Einstellungen' },
];
const GOOGLE =
  /^https:\/\/(www\.googletagmanager\.com|[a-z0-9-]+\.google-analytics\.com|[a-z0-9-]+\.google\.com)\//;

/** A stand-in for gtag.js: reads the dataLayer like the real tag, honours consent and ga-disable,
 *  writes the _ga cookies and sends one page_view to the (mocked) collection endpoint. */
const MOCK_TAG = `(() => {
  const id = new URL(document.currentScript.src).searchParams.get('id');
  const consent = {};
  const hit = (en) => {
    if (window['ga-disable-' + id] || consent.analytics_storage !== 'granted') return;
    document.cookie = '_ga=GA1.1.42.42; path=/; max-age=63072000; domain=' + location.hostname;
    document.cookie = '_ga_' + id.slice(2) + '=GS1.1.42; path=/; max-age=63072000; domain=' + location.hostname;
    fetch('https://region1.google-analytics.com/g/collect?v=2&tid=' + id + '&en=' + en, { method: 'POST', mode: 'no-cors', keepalive: true });
  };
  const handle = (a) => {
    if (a[0] === 'consent') Object.assign(consent, a[2]);
    if (a[0] === 'config') hit('page_view');
    if (a[0] === 'event') hit(a[1]);
  };
  for (const a of window.dataLayer) handle(a);
  const push = window.dataLayer.push.bind(window.dataLayer);
  window.dataLayer.push = (a) => { handle(a); return push(a); };
})();`;

/** Catches every request leaving the container: Google ones are mocked and counted, all others
 *  are aborted and counted as foreign. Console errors (a CSP refusal among them) are collected. */
async function guard(context) {
  const google = [];
  const foreign = [];
  const errors = [];
  await context.route(
    (url) => url.host !== SELF && url.host !== PUBLIC,
    (route) => {
      const url = route.request().url();
      if (!GOOGLE.test(url)) {
        foreign.push(url);
        return route.abort();
      }
      google.push(url);
      if (url.startsWith('https://www.googletagmanager.com/gtag/js')) {
        return route.fulfill({ contentType: 'text/javascript', body: MOCK_TAG });
      }
      return route.fulfill({ status: 204, body: '' });
    },
  );
  context.on('page', (page) => {
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
  });
  return { google, foreign, errors };
}

const choice = (page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem('ayvo.consent');
    return raw && JSON.parse(raw);
  });
const gaCookies = async (context) =>
  (await context.cookies()).filter((c) => /^_ga($|_)/.test(c.name)).map((c) => c.name);

test.describe('the test host (like the DEV preview): the choice works, Google is never loaded', () => {
  test('first visit: two equal choices, none preselected, nothing external, the CTA stays free', async ({
    browser,
  }) => {
    for (const width of [1440, 390, 320]) {
      for (const p of PAGES) {
        const context = await browser.newContext({
          baseURL: TEST_URL,
          viewport: { width, height: 844 },
        });
        const net = await guard(context);
        const page = await context.newPage();
        await page.goto(p.path, { waitUntil: 'networkidle' });
        const banner = page.locator('[data-consent-banner]');
        await expect(banner).toBeVisible();
        const allow = banner.getByRole('button', { name: p.allow, exact: true });
        const deny = banner.getByRole('button', { name: p.deny, exact: true });
        await expect(allow).toBeVisible();
        await expect(deny).toBeVisible();
        // Equal weight: the same look and size; neither has the focus or a pressed state.
        const style = (b) =>
          b.evaluate((el) => {
            const s = getComputedStyle(el);
            return [
              s.backgroundColor,
              s.color,
              s.borderColor,
              s.fontWeight,
              s.fontSize,
              el.offsetHeight,
            ];
          });
        expect(await style(allow)).toEqual(await style(deny));
        expect((await allow.boundingBox()).height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        expect(await choice(page)).toBeNull();
        expect(await gaCookies(context)).toEqual([]);
        // The hero CTA is not covered: it is what a click at its centre hits.
        const cta = page.locator('#top a[href="#pilot"]');
        const box = await cta.boundingBox();
        expect(
          await page.evaluate(
            ([x, y]) => !!document.elementFromPoint(x, y)?.closest('a[href="#pilot"]'),
            [box.x + box.width / 2, box.y + box.height / 2],
          ),
          `${p.path} at ${width}px`,
        ).toBe(true);
        expect(net.google).toEqual([]);
        expect(net.foreign).toEqual([]);
        expect(net.errors).toEqual([]);
        await context.close();
      }
    }
  });

  test('allowing on a non-public host stores the choice for every language but loads nothing', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: TEST_URL,
      viewport: { width: 1440, height: 900 },
    });
    const net = await guard(context);
    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Allow analytics', exact: true }).click();
    await expect(page.locator('[data-consent-banner]')).toBeHidden();
    const stored = await choice(page);
    expect(stored.v).toBe(1);
    expect(stored.analytics).toBe('granted');
    await page.goto('/cz/', { waitUntil: 'networkidle' });
    await expect(page.locator('[data-consent-banner]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Nastavení analytiky' })).toBeVisible();
    expect(await page.evaluate(() => typeof window.dataLayer)).toBe('undefined');
    expect(net.google).toEqual([]);
    expect(net.foreign).toEqual([]);
    expect(net.errors).toEqual([]);
    await context.close();
  });

  test('keyboard on a phone: details and the choice right after the skip link; the footer opens it again', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: TEST_URL,
      viewport: { width: 390, height: 844 },
    });
    const net = await guard(context);
    const page = await context.newPage();
    await page.goto('/de/', { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    await expect(page.locator('a.ayvo-skip')).toBeFocused();
    // The details (what is sent) open from the keyboard, then the two choices.
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-consent-banner] summary')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-consent-banner] details')).toHaveAttribute('open', '');
    await expect(page.locator('[data-consent-banner] details p')).toContainText('_ga');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Analyse erlauben' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Ablehnen' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-consent-banner]')).toBeHidden();
    expect((await choice(page)).analytics).toBe('denied');

    const opener = page.getByRole('button', { name: 'Analyse-Einstellungen' });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-consent-banner]')).toBeVisible();
    await expect(page.locator('[data-consent-status]')).toHaveText(
      'Aktuelle Wahl: Analyse abgelehnt.',
    );
    await expect(page.getByRole('button', { name: 'Analyse erlauben' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-consent-banner]')).toBeHidden();
    await expect(opener).toBeFocused();
    expect((await choice(page)).analytics).toBe('granted');
    expect(net.google).toEqual([]);
    expect(net.foreign).toEqual([]);
    await context.close();
  });

  test('an old version or an expired choice is asked again and removed', async ({ browser }) => {
    for (const old of [
      { v: 0, analytics: 'granted', at: new Date().toISOString() },
      { v: 1, analytics: 'granted', at: new Date(Date.now() - 181 * 864e5).toISOString() },
    ]) {
      const context = await browser.newContext({ baseURL: TEST_URL });
      await context.addInitScript((v) => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('ayvo.consent', JSON.stringify(v));
          sessionStorage.setItem('seeded', '1');
        }
      }, old);
      const net = await guard(context);
      const page = await context.newPage();
      await page.goto('/', { waitUntil: 'networkidle' });
      await expect(page.locator('[data-consent-banner]')).toBeVisible();
      expect(await choice(page)).toBeNull();
      expect(net.google).toEqual([]);
      await context.close();
    }
  });
});

test.describe('the public hostname in an isolated browser (Google transport mocked)', () => {
  test('nothing before the choice, after "Decline" or on reload; one tag with the right ID after "Allow"', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: PUBLIC_URL,
      viewport: { width: 1440, height: 900 },
    });
    const net = await guard(context);
    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('[data-consent-banner]')).toBeVisible();
    expect(net.google).toEqual([]);
    await page.getByRole('button', { name: 'Decline', exact: true }).click();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('[data-consent-banner]')).toBeHidden();
    // A query and a fragment on the page and its referrer are never sent (see the config below).
    await page.goto('/cz/?email=a%40b.cz&utm_source=x#pilot', {
      waitUntil: 'networkidle',
      referer: `${PUBLIC_URL}/?token=secret#top`,
    });
    expect(net.google).toEqual([]);
    expect(await gaCookies(context)).toEqual([]);

    await page.getByRole('button', { name: 'Nastavení analytiky' }).click();
    await page.getByRole('button', { name: 'Povolit analytiku', exact: true }).click();
    await expect.poll(() => net.google.length).toBe(2);
    expect(net.google[0]).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
    expect(net.google[1]).toMatch(
      new RegExp(
        `^https://region1\\.google-analytics\\.com/g/collect\\?v=2&tid=${ID}&en=page_view$`,
      ),
    );
    expect(await page.locator('script[src*="googletagmanager"]').count()).toBe(1);
    const layer = await page.evaluate(() => window.dataLayer.map((a) => Array.from(a)));
    expect(layer.find((a) => a[0] === 'consent' && a[1] === 'default')[2]).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    expect(layer.filter((a) => a[0] === 'consent' && a[1] === 'update')).toEqual([
      ['consent', 'update', { analytics_storage: 'granted' }],
    ]);
    expect(layer.filter((a) => a[0] === 'config')).toEqual([
      [
        'config',
        ID,
        {
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
          page_location: `${PUBLIC_URL}/cz/`,
          page_referrer: `${PUBLIC_URL}/`,
          cookie_expires: 180 * 24 * 60 * 60,
          cookie_update: false,
        },
      ],
    ]);
    expect(layer.filter((a) => a[0] === 'event')).toEqual([]);
    expect(JSON.stringify(layer)).not.toMatch(/user_id|email|secret|utm_|#/);
    expect((await gaCookies(context)).sort()).toEqual(['_ga', `_ga_${ID.slice(2)}`]);

    // The choice holds for the other languages: the tag again once per page, no banner.
    await page.goto('/de/', { waitUntil: 'networkidle' });
    await expect(page.locator('[data-consent-banner]')).toBeHidden();
    await expect.poll(() => net.google.length).toBe(4);
    expect(net.foreign).toEqual([]);
    expect(net.errors).toEqual([]);
    await context.close();
  });

  test('withdrawal stops measuring at once in every open tab, removes _ga and reloads', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: PUBLIC_URL,
      viewport: { width: 390, height: 844 },
    });
    const net = await guard(context);
    const a = await context.newPage();
    await a.goto('/', { waitUntil: 'networkidle' });
    await a.getByRole('button', { name: 'Allow analytics', exact: true }).click();
    const b = await context.newPage();
    await b.goto('/cz/', { waitUntil: 'networkidle' });
    await expect.poll(() => net.google.length).toBe(4);
    expect((await gaCookies(context)).length).toBe(2);

    // Withdrawn in tab A (EN, footer): A and B (CZ) reload by themselves.
    const bReloaded = b.waitForEvent('load');
    const aReloaded = a.waitForEvent('load');
    await a.getByRole('button', { name: 'Analytics settings' }).click();
    await a.getByRole('button', { name: 'Decline', exact: true }).click();
    await Promise.all([aReloaded, bReloaded]);
    await a.waitForLoadState('networkidle');
    await b.waitForLoadState('networkidle');
    const before = net.google.length;
    expect(await gaCookies(context)).toEqual([]);
    for (const page of [a, b]) {
      expect(await page.evaluate(() => typeof window.dataLayer)).toBe('undefined');
      expect(await page.locator('script[src*="googletagmanager"]').count()).toBe(0);
      expect(await page.evaluate((id) => window[`ga-disable-${id}`], ID)).toBe(true);
      await page.reload({ waitUntil: 'networkidle' });
    }
    expect(net.google.length).toBe(before);
    expect(before).toBe(4);
    expect(net.foreign).toEqual([]);
    expect(net.errors).toEqual([]);
    await context.close();
  });
});
