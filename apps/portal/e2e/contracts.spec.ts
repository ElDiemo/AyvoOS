import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });
const stubState = async (page: Page) =>
  (await (await page.request.get(`${STUB}/__state`)).json()) as {
    hotelId: string;
    contract: { id: string; signedOn: string };
    foreignContractId: string;
  };
const shot = async (page: Page, name: string) => {
  const dir = process.env.PORTAL_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${name}-${page.viewportSize()!.width}.png`),
    fullPage: true,
  });
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('[name=email]').fill('recepce@hotel-e2e.test');
  await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}

/**
 * "Smlouvy" on the hotel page against the core stub (which signed originals a session sees is
 * tested against the real core in the API suite): the signed contract and its PDF, the empty
 * state, a core that does not answer (the profile stays), a foreign contract.
 */
test.describe('hotel portal: signed contracts', () => {
  test.beforeEach(async ({ page }) => {
    await control(page, { resetProfile: true });
  });

  test('the signed contract and its PDF; empty and unavailable states keep the profile', async ({
    page,
  }) => {
    await signIn(page);
    const { hotelId, contract, foreignContractId } = await stubState(page);
    await page.goto(`/hotels/${hotelId}`);
    const card = page.getByTestId('profile-contracts');
    await expect(card).toContainText('Smlouva podepsaná 15. 10. 2026');
    await expect(card).toContainText('Služba od 1. 11. 2026');
    await shot(page, 'profile-contracts');
    const href = await card.getByRole('link', { name: 'Stáhnout PDF' }).getAttribute('href');
    expect(href).toBe(`/contracts/${contract.id}/pdf`);
    const pdf = await page.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect(pdf.headers()['content-disposition']).toBe(
      'attachment; filename="AYVO-smlouva-2026-10-15.pdf"',
    );
    expect(pdf.headers()['cache-control']).toBe('private, no-store');
    expect(pdf.headers()['content-security-policy']).toContain("default-src 'none'");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const foreign = await page.request.get(`/contracts/${foreignContractId}/pdf`);
    expect(foreign.status()).toBe(404);

    await control(page, { contractsMode: 'none' });
    await page.reload();
    await expect(card).toContainText('Zatím tu není žádná podepsaná smlouva.');

    await control(page, { contractsMode: 'down' });
    await page.reload();
    await expect(card).toContainText('Smlouvy se teď nepodařilo načíst.');
    await expect(page.getByTestId('portal-hotel-name')).toHaveText('Hotel Portál E2E');

    await page.context().clearCookies();
    expect((await page.request.get(href!)).status()).toBe(401);
  });
});
