import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { json } from './dispatch-setup';
import { deliveredReceipt, type SeededCrate } from './returns-receipt-setup';

/**
 * Příjem vratek with more than 20 bottles (R1.1, #203): the page loads only the latest 20 bottles
 * of a line after each scan; the counts stay complete. "Zobrazit všechny" keeps the full list
 * through further scans (also another operator's). Two refreshes that overlap — a manual
 * "Obnovit" and a later one, with another operator's scan in between — never put the older
 * answer on the screen. 3 crates × 10 bottles, SIMULATED delivery, FAKE test carrier. Every
 * bottle is scanned as defective (retired): none of them joins the site's wash queue, which other
 * specs count.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const C = 10;
let receipt = '';
let crates: SeededCrate[] = [];
let otherContext: BrowserContext;
let other: APIRequestContext;

const counts = (identified: number) =>
  `Bedny 3 · přijaté lahve ${identified} (z toho ke skartaci ${identified}) · nečitelné 0`;
const otherScan = async (url: string) =>
  json(
    await other.post(`/api/admin/returns/receipts/${receipt}/bottles`, {
      data: { requestId: crypto.randomUUID(), scannedValue: url, outcome: 'DEFECTIVE' },
    }),
  );
async function scan(page: Page, url: string) {
  await page.getByRole('radio', { name: 'Vadná → ke skartaci' }).first().check();
  await page.getByRole('textbox', { name: 'Naskenujte lahev' }).fill(url);
  await page.getByRole('button', { name: 'Zapsat lahev' }).click();
}
const isDetail = (url: URL) => url.pathname === `/api/admin/returns/receipts/${receipt}`;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  otherContext = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  other = otherContext.request;
  ({ receipt, crates } = await deliveredReceipt(other, {
    crates: 3,
    capacity: C,
    name: 'Zobrazení příjmu',
  }));
  // Another operator already freed the crates and received 23 bottles.
  for (const c of crates)
    await json(
      await other.post(`/api/admin/returns/receipts/${receipt}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: c.url },
      }),
    );
  for (const url of [
    ...crates[0]!.bottles,
    ...crates[1]!.bottles,
    ...crates[2]!.bottles.slice(0, 3),
  ])
    await otherScan(url);
});
test.afterAll(() => otherContext?.close());

test('"Zobrazit všechny" keeps the full list through further scans, also another operator’s', async ({
  page,
}) => {
  await page.goto(`/production/cycle/returns/${receipt}`);
  const card = page.getByTestId('return-line-bottles');
  const listed = card.getByTestId('line-bottles').locator('li');
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(23));
  await expect(listed).toHaveCount(20);
  await expect(card.getByTestId('line-bottles-recent')).toHaveText('Posledních 20 z 23 lahví');

  await card.getByRole('button', { name: 'Zobrazit všechny lahve (23)' }).click();
  await expect(listed).toHaveCount(23);
  await expect(card.getByTestId('line-bottles-recent')).toHaveCount(0);

  // A further scan in that view: the full list, one more.
  await scan(page, crates[2]!.bottles[3]!);
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(24));
  await expect(listed).toHaveCount(24);
  await expect(card.getByTestId('line-bottles-recent')).toHaveCount(0);

  // Another operator scans, then this page: both are in the full list.
  await otherScan(crates[2]!.bottles[4]!);
  await scan(page, crates[2]!.bottles[5]!);
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(26));
  await expect(listed).toHaveCount(26);
  await expect(card.getByTestId('line-bottles-recent')).toHaveCount(0);

  // Opened again: the latest 20 of 26.
  await page.reload();
  await expect(listed).toHaveCount(20);
  await expect(card.getByTestId('line-bottles-recent')).toHaveText('Posledních 20 z 26 lahví');
});

test('an older refresh that answers last never replaces a newer one (manual Obnovit × another operator)', async ({
  page,
}) => {
  await page.goto(`/production/cycle/returns/${receipt}`);
  const card = page.getByTestId('return-line-bottles');
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(26));

  // The refresh after this page's scan fails once: the scan is written, the page offers Obnovit.
  let failNext = true;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let fetchedOld: () => void = () => {};
  const oldFetched = new Promise<void>((r) => (fetchedOld = r));
  let hold = false;
  await page.route(isDetail, async (route: Route) => {
    if (failNext) {
      failNext = false;
      return route.abort();
    }
    if (hold) {
      // Obnovit #1: read from the server NOW (27 bottles), answered only after Obnovit #2.
      hold = false;
      const response = await route.fetch();
      fetchedOld();
      await held;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await scan(page, crates[2]!.bottles[6]!);
  await expect(page.getByTestId('refresh-failed')).toBeVisible();

  hold = true;
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await oldFetched;
  // Meanwhile another operator scans the 28th bottle; Obnovit #2 shows it.
  await otherScan(crates[2]!.bottles[7]!);
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(28));
  await expect(card.getByTestId('line-bottles-recent')).toHaveText('Posledních 20 z 28 lahví');
  await expect(page.getByTestId('refresh-failed')).toHaveCount(0);

  // Now the older answer (27) arrives: the screen keeps 28.
  const late = page.waitForResponse((r) => isDetail(new URL(r.url())));
  release();
  await late;
  await page.waitForTimeout(500);
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(28));
  await expect(card.getByTestId('line-bottles-recent')).toHaveText('Posledních 20 z 28 lahví');
  await expect(page.getByTestId('refresh-failed')).toHaveCount(0);
  await page.unroute(isDetail);

  // And the next scan goes on from there.
  await scan(page, crates[2]!.bottles[8]!);
  await expect(page.getByTestId('receipt-counts')).toHaveText(counts(29));
});
