import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';

/** Shared helpers of the Obchod specs (doc 034): sign-in of salespeople, synthetic prospects. */
const SHOTS = process.env.AYVO_SCREENSHOT_DIR;

export function pragueDay(offset = 0): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
}

export async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

export async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ timezoneId: 'America/New_York' });
  const page = await context.newPage();
  await page.goto(`/api/auth/login?next=/&login_hint=${encodeURIComponent(email)}`);
  await page.waitForURL((u) => u.pathname === '/');
  return page;
}

export const prospect = (name: string, extra: object = {}) => ({
  requestId: crypto.randomUUID(),
  name,
  countryCode: 'CZ',
  city: null,
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  roomsEstimate: null,
  accommodationType: null,
  website: null,
  source: null,
  priority: null,
  note: null,
  ownerId: null,
  contact: null,
  acknowledgeDuplicates: true,
  ...extra,
});
