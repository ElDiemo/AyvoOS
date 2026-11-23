import { expect, test } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

type Me = { activeSiteId: string | null; sites: { id: string }[] };

test('the site switcher takes a choice only once it works: never a changed control with the old site still active', async ({
  page,
}) => {
  const me = async () => (await (await page.request.get('/api/auth/me')).json()) as Me;
  const other = (await me()).sites.find((s) => s.id !== INITIAL_SITE_ID)!;
  expect(
    (await page.request.post('/api/auth/active-site', { data: { siteId: other.id } })).ok(),
  ).toBe(true);
  try {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/auth/active-site')) posts.push(r.url());
    });
    // The page's scripts arrive late: the server's HTML is on screen, React not yet hydrated.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/_next/static/chunks/**', async (route) => {
      await held;
      return route.continue();
    });
    await page.goto('/production/cycle/after-wash', { waitUntil: 'commit' });
    const switcher = page.getByTestId('site-switcher');
    await expect(page.getByRole('heading', { name: 'Po mytí', exact: true })).toBeVisible();
    await expect(switcher).toHaveValue(other.id);
    await expect(switcher).toBeDisabled();
    release();
    // Once hydrated it works: its POST, the session's site and the reloaded page all agree.
    await expect(switcher).toBeEnabled();
    expect(posts).toHaveLength(0);
    const switched = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/auth/active-site'),
    );
    const reloaded = page.waitForEvent('framenavigated', (f) => f === page.mainFrame());
    await switcher.selectOption(INITIAL_SITE_ID);
    expect((await switched).status()).toBe(200);
    await reloaded;
    await page.waitForLoadState('load');
    expect((await me()).activeSiteId).toBe(INITIAL_SITE_ID);
    await expect(switcher).toBeEnabled();
    await expect(switcher).toHaveValue(INITIAL_SITE_ID);
  } finally {
    // The shared admin session stays where auth.setup left it.
    await page.request.post('/api/auth/active-site', { data: { siteId: INITIAL_SITE_ID } });
  }
});
