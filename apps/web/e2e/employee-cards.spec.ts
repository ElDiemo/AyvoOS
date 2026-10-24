import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test, type Locator } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** The one publication status: the server's state as text, the dot only decorative. */
async function expectPublication(editor: Locator, state: 'Zveřejněno' | 'Nezveřejněno') {
  const status = editor.getByTestId('employee-card-publication');
  await expect(status.locator('p').first()).toHaveText(state);
  await expect(status.locator('[aria-hidden="true"]')).toHaveClass(
    state === 'Zveřejněno' ? /bg-emerald-600/ : /bg-red-600/,
  );
}

test('concurrent first save keeps edited fields but adopts the permanent address from the server', async ({
  page,
}) => {
  const created = await page.request.post('/api/admin/identity/users', {
    data: {
      email: `employee-conflict-${randomUUID()}@ayvo.test`,
      displayName: 'Konflikt Vizitky',
      roles: ['SALES'],
      siteIds: [],
      warehouseCodes: [],
      reason: 'synthetic card conflict',
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const base = `/api/admin/identity/users/${id}/business-card`;
  await page.goto(`/admin/users/${id}`);
  const editor = page.getByTestId('employee-card-editor');
  await editor.getByRole('button', { name: 'Otevřít nastavení vizitky' }).click();
  await editor.getByLabel('Adresa na vizitce').fill(`proposed-${randomUUID()}`);
  await editor.getByLabel('Veřejné jméno').fill('Moje rozepsané jméno');
  await editor.getByLabel('Důvod změny', { exact: true }).fill('Moje rozepsaná úprava');
  const slug = `canonical-${randomUUID()}`;
  const other = await page.request.post(base, {
    data: {
      requestId: randomUUID(),
      expectedVersion: 0,
      slug,
      reason: 'other administrator saved first',
      fields: {
        name: 'Jméno uložené jiným správcem',
        role: '',
        company: '',
        tagline: '',
        phone: '',
        email: '',
        website: '',
        linkedin: '',
        photoId: null,
      },
    },
  });
  expect(other.status()).toBe(200);
  await editor.getByRole('button', { name: 'Uložit koncept', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Na serveru je novější verze');
  await editor.getByRole('button', { name: 'Načíst aktuální stav', exact: true }).click();
  await expect(editor.getByLabel('Veřejné jméno')).toHaveValue('Moje rozepsané jméno');
  await expect(editor.getByLabel('Adresa na vizitce')).toHaveValue(slug);
  await expect(editor.getByRole('region', { name: 'Aktuální uložený koncept' })).toContainText(
    'Jméno uložené jiným správcem',
  );
  await editor.getByRole('button', { name: 'Uložit koncept', exact: true }).click();
  await expect(editor.getByText('Koncept uložen. Veřejná vizitka se nezměnila.')).toBeVisible();
  const saved = await page.request.get(base);
  expect(((await saved.json()) as { card: { draft: { name: string } } }).card.draft.name).toBe(
    'Moje rozepsané jméno',
  );
});

test('admin prepares and publishes a card; draft and hidden data never appear publicly', async ({
  page,
  browser,
}) => {
  const slug = `jana-${randomUUID()}`;
  const created = await page.request.post('/api/admin/identity/users', {
    data: {
      email: `employee-${randomUUID()}@ayvo.test`,
      displayName: 'Jana Vizitková',
      roles: ['SALES'],
      siteIds: [],
      warehouseCodes: [],
      reason: 'synthetic business-card browser test',
    },
  });
  expect(created.status()).toBe(201);
  const user = (await created.json()) as { id: string };
  await page.goto(`/admin/users/${user.id}`);
  const editor = page.getByTestId('employee-card-editor');
  await editor.getByRole('button', { name: 'Otevřít nastavení vizitky' }).click();
  await expect(editor.getByLabel('Veřejný e-mail', { exact: true })).toHaveValue('');
  await expectPublication(editor, 'Nezveřejněno');
  // The preview is labelled by a heading; the former preview toggles are gone.
  await expect(editor.getByRole('heading', { name: 'Náhled rozepsaných údajů' })).toBeVisible();
  for (const name of ['Náhled konceptu', 'Nyní zveřejněno', 'Náhled rozepsaných údajů'])
    await expect(editor.getByRole('button', { name })).toHaveCount(0);
  await editor.getByLabel('Adresa na vizitce').fill(slug);
  await editor.getByLabel('Pracovní pozice', { exact: true }).fill('Obchodní zástupkyně');
  await editor
    .getByLabel('Krátké představení')
    .fill('Syntetická ukázka, nikoli skutečný zaměstnanec.');
  await editor.getByLabel('Pracovní telefon').fill('+420 111 222 333');
  await editor.getByLabel('Veřejný e-mail', { exact: true }).fill('vizitka@example.com');
  await editor.getByLabel('Web (HTTPS)', { exact: true }).fill('https://example.com');
  await editor
    .getByLabel('LinkedIn (HTTPS)', { exact: true })
    .fill('https://www.linkedin.com/in/example');
  const require = createRequire(import.meta.url);
  const { createCanvas, loadImage } =
    require('../../api/node_modules/@napi-rs/canvas') as typeof import('../../api/node_modules/@napi-rs/canvas');
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#e7e5e4';
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = '#44403c';
  context.font = 'bold 25px sans-serif';
  context.textAlign = 'center';
  context.fillText('JV', 32, 41);
  await editor.getByLabel('Fotografie', { exact: true }).setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: canvas.toBuffer('image/png'),
  });
  await expect(editor.getByText('Fotografie je v konceptu.', { exact: false })).toBeVisible();
  await editor.getByLabel('Důvod změny', { exact: true }).fill('Příprava syntetické vizitky');
  await editor.getByRole('button', { name: 'Uložit koncept', exact: true }).click();
  await expect(editor.getByText('Koncept uložen. Veřejná vizitka se nezměnila.')).toBeVisible();
  expect((await page.request.get(`/api/public/employee-cards/${slug}`)).status()).toBe(404);
  await expectPublication(editor, 'Nezveřejněno');
  await editor
    .getByLabel('Důvod změny', { exact: true })
    .fill('Výslovné zveřejnění testovací vizitky');
  await editor.getByRole('button', { name: 'Zveřejnit uložený koncept' }).click();
  await expect(editor.getByText('Uložený koncept byl zveřejněn.')).toBeVisible();
  await expectPublication(editor, 'Zveřejněno');
  await expect(editor.getByText('obsahuje změny, které zatím nejsou zveřejněné')).toHaveCount(0);
  const publishedLink = editor.getByRole('link', { name: 'Otevřít zveřejněnou vizitku' });
  await expect(publishedLink).toHaveAttribute('href', `/id/${slug}`);
  await expect(publishedLink).toHaveAttribute('target', '_blank');

  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const publicPage = await anonymous.newPage();
  await publicPage.goto((await publishedLink.getAttribute('href'))!);
  await expect(publicPage.getByRole('heading', { name: 'Jana Vizitková' })).toBeVisible();
  await expect(publicPage.getByRole('img', { name: 'Jana Vizitková' })).toBeVisible();
  const oldPhoto = new URL(
    (await publicPage.getByRole('img', { name: 'Jana Vizitková' }).getAttribute('src'))!,
    publicPage.url(),
  ).href;
  expect((await anonymous.request.get(oldPhoto)).status()).toBe(200);
  const pendingDownload = publicPage.waitForEvent('download');
  await publicPage.getByRole('link', { name: 'Save contact' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe(`${slug}.vcf`);
  const file = await download.path();
  // UTF-8 with diacritics, CRLF lines, only the published public fields.
  const vcard = await readFile(file!, 'utf8');
  expect(vcard.split('\r\n')).toEqual([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Jana Vizitková',
    'N:;;;;',
    'TITLE:Obchodní zástupkyně',
    'NOTE:Syntetická ukázka\\, nikoli skutečný zaměstnanec.',
    'TEL;TYPE=WORK,VOICE:+420 111 222 333',
    'EMAIL;TYPE=WORK:vizitka@example.com',
    'URL:https://example.com',
    'X-SOCIALPROFILE;TYPE=linkedin:https://www.linkedin.com/in/example',
    'END:VCARD',
    '',
  ]);
  expect(vcard).not.toContain('@ayvo.test');
  const vcf = await anonymous.request.get(`/id/${slug}/contact.vcf`);
  expect(vcf.headers()['content-type']).toBe('text/vcard; charset=utf-8');
  // The original links: web and LinkedIn open safely, phone and e-mail as tel:/mailto:.
  const card = publicPage.getByRole('article');
  for (const [name, href] of <[string, string][]>[
    ['Visit AYVO', 'https://example.com'],
    ['Call', 'tel:+420111222333'],
    ['Email', 'mailto:vizitka@example.com'],
    ['LinkedIn', 'https://www.linkedin.com/in/example'],
    ['Save contact', `${slug}/contact.vcf`],
  ]) {
    await expect(card.getByRole('link', { name })).toHaveAttribute('href', href);
  }
  await expect(card.getByRole('link', { name: 'Visit AYVO' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  // The existing id.ayvo.co favicon on cards only; AYVO OS keeps its own icon.
  const icons = (target: typeof publicPage) =>
    target
      .locator('link[rel="icon"]')
      .evaluateAll((links) =>
        links.map((link) => new URL((link as HTMLLinkElement).href).pathname),
      );
  expect(await icons(publicPage)).toEqual(['/employee-card/favicon.ico']);
  const favicon = await anonymous.request.get('/employee-card/favicon.ico');
  expect(favicon.status()).toBe(200);
  expect(
    createHash('sha256')
      .update(await favicon.body())
      .digest('hex'),
  ).toBe('53af376423d364ac89250cddf073f317a3e7d7e049439f96d40501311770be62');
  expect(await icons(page)).not.toContain('/employee-card/favicon.ico');

  await editor.getByLabel('Veřejné jméno').fill('Jana – rozepsaná neveřejná změna');
  await expect(editor.getByRole('button', { name: 'Zveřejnit uložený koncept' })).toBeDisabled();
  await editor.getByLabel('Důvod změny', { exact: true }).fill('Pouze koncept změny jména');
  await editor.getByRole('button', { name: 'Uložit koncept', exact: true }).click();
  await expect(editor.getByText('Koncept uložen. Veřejná vizitka se nezměnila.')).toBeVisible();
  // A saved, different draft leaves the valid publication public — still green.
  await expectPublication(editor, 'Zveřejněno');
  await expect(editor.getByText('obsahuje změny, které zatím nejsou zveřejněné')).toBeVisible();
  await publicPage.reload();
  await expect(publicPage.getByRole('heading', { name: 'Jana Vizitková' })).toBeVisible();
  await page.reload();
  await editor.getByRole('button', { name: 'Otevřít nastavení vizitky' }).click();
  await expectPublication(editor, 'Zveřejněno');
  await expect(editor.getByLabel('Veřejné jméno')).toHaveValue('Jana – rozepsaná neveřejná změna');
  await expect(editor.getByLabel('Adresa na vizitce')).toHaveAttribute('readonly', '');
  const previewPhoto = editor.getByRole('img', {
    name: 'Jana – rozepsaná neveřejná změna',
    exact: true,
  });
  await expect
    .poll(() =>
      previewPhoto.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/employee-cards');
  await mkdir(screenshots, { recursive: true });
  // Independent historical HTML/CSS, not a snapshot regenerated from the new component.
  const reference = await anonymous.newPage();
  // Keep the reference same-origin: about:blank would reject the self-hosted fonts by CORS.
  await reference.goto('/employee-card/FONT-AWESOME-LICENSE.txt');
  const legacy = await readFile(
    resolve(import.meta.dirname, 'fixtures/employee-card-legacy.html'),
    'utf8',
  );
  await reference.setContent(
    legacy
      .replace('{{ORIGIN}}', new URL(publicPage.url()).origin)
      .replace('{{PHOTO}}', oldPhoto.replaceAll('&', '&amp;').replaceAll('"', '&quot;'))
      .replace('{{CONTACT}}', `/id/${slug}/contact.vcf`),
  );
  for (const current of [publicPage, reference]) {
    await current.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map((image) => image.decode()));
    });
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await publicPage.setViewportSize({ width, height: 900 });
    await reference.setViewportSize({ width, height: 900 });
    await publicPage.mouse.move(0, 0);
    await reference.mouse.move(0, 0);
    for (const current of [page, publicPage])
      expect(
        await current.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    await editor.scrollIntoViewIfNeeded();
    await editor.screenshot({
      path: resolve(screenshots, `employee-card-editor-${width}.png`),
    });
    await publicPage.screenshot({
      path: resolve(screenshots, `employee-card-public-${width}.png`),
      fullPage: true,
    });
    // The DEV notice above the card moves it down; blurred shadows rasterize per absolute
    // position, so the reference card is drawn at exactly the same place (no layout change).
    const [actualBox, referenceBox] = await Promise.all([
      publicPage.getByRole('article').boundingBox(),
      reference.locator('.card').boundingBox(),
    ]);
    await reference.locator('.card').evaluate((card: HTMLElement, shift: number) => {
      card.style.position = 'relative';
      card.style.top = `${(parseFloat(card.style.top) || 0) + shift}px`;
    }, actualBox!.y - referenceBox!.y);
    const moved = (await reference.locator('.card').boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(moved[key], key).toBeCloseTo(actualBox![key], 2);
    }
    const actualImage = await publicPage
      .getByRole('article')
      .screenshot({ animations: 'disabled' });
    const referenceImage = await reference.locator('.card').screenshot({ animations: 'disabled' });
    const images = await Promise.all([loadImage(actualImage), loadImage(referenceImage)]);
    expect([images[0]!.width, images[0]!.height]).toEqual([images[1]!.width, images[1]!.height]);
    const pixels = images.map((image) => {
      const context = createCanvas(image.width, image.height).getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    });
    let largestDifference = 0;
    for (let i = 0; i < pixels[0]!.length; i++)
      largestDifference = Math.max(largestDifference, Math.abs(pixels[0]![i]! - pixels[1]![i]!));
    // A one-level rounding difference at composited rounded edges is not a design change.
    expect(largestDifference, `unchanged legacy card pixels at ${width}px`).toBeLessThanOrEqual(1);
  }
  await reference.close();
  await editor.getByLabel('Veřejné jméno').fill('Nesmí se ztratit při skrytí');
  await editor.getByLabel('Důvod změny', { exact: true }).fill('Skrytí testovací vizitky');
  await editor.getByRole('button', { name: 'Skrýt vizitku', exact: true }).click();
  await expect(editor.getByText('Vizitka byla skryta.')).toBeVisible();
  await expectPublication(editor, 'Nezveřejněno');
  await expect(publishedLink).toHaveCount(0);
  await expect(editor.getByLabel('Veřejné jméno')).toHaveValue('Nesmí se ztratit při skrytí');
  expect((await anonymous.request.get(`/id/${slug}`)).status()).toBe(404);
  expect((await anonymous.request.get(oldPhoto!)).status()).toBe(404);
  expect((await publicPage.reload())?.status()).toBe(404);
  await expect(publicPage.getByRole('heading', { name: 'Contact unavailable' })).toBeVisible();
  await expect(publicPage.getByRole('link')).toHaveCount(0);
  await anonymous.close();
});

test('deactivation unpublishes the card; reactivation does not publish it again', async ({
  page,
}) => {
  const slug = `petr-${randomUUID()}`;
  const created = await page.request.post('/api/admin/identity/users', {
    data: {
      email: `employee-${randomUUID()}@ayvo.test`,
      displayName: 'Petr Syntetický',
      roles: ['SALES'],
      siteIds: [],
      warehouseCodes: [],
      reason: 'synthetic business-card status test',
    },
  });
  expect(created.status()).toBe(201);
  const user = (await created.json()) as { id: string };
  const base = `/api/admin/identity/users/${user.id}/business-card`;
  const fields = {
    name: 'Petr Syntetický',
    role: 'Test',
    company: '',
    tagline: '',
    phone: '',
    email: '',
    website: '',
    linkedin: '',
    photoId: null,
  };
  const saved = await page.request.post(base, {
    data: { requestId: randomUUID(), expectedVersion: 0, reason: 'synthetic', slug, fields },
  });
  expect(saved.status()).toBe(200);
  const version = ((await saved.json()) as { card: { version: number } }).card.version;
  expect(
    (
      await page.request.post(`${base}/publish`, {
        data: { requestId: randomUUID(), expectedVersion: version, reason: 'synthetic' },
      })
    ).status(),
  ).toBe(200);
  const editor = page.getByTestId('employee-card-editor');
  const open = async () => {
    await page.goto(`/admin/users/${user.id}`);
    await editor.getByRole('button', { name: 'Otevřít nastavení vizitky' }).click();
  };
  await open();
  await expectPublication(editor, 'Zveřejněno');

  const status = (action: 'deactivate' | 'reactivate') =>
    page.request.post(`/api/admin/identity/users/${user.id}/${action}`, {
      data: { reason: `synthetic ${action}` },
    });
  expect((await status('deactivate')).ok()).toBe(true);
  await open();
  await expectPublication(editor, 'Nezveřejněno');
  await expect(editor.getByText('Účet je deaktivovaný.', { exact: false })).toBeVisible();
  await expect(editor.getByRole('link', { name: 'Otevřít zveřejněnou vizitku' })).toHaveCount(0);
  expect((await page.request.get(`/api/public/employee-cards/${slug}`)).status()).toBe(404);

  expect((await status('reactivate')).ok()).toBe(true);
  await open();
  await expectPublication(editor, 'Nezveřejněno');
  await expect(editor.getByText('Účet je deaktivovaný.', { exact: false })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Zveřejnit uložený koncept' })).toBeEnabled();
  expect((await page.request.get(`/api/public/employee-cards/${slug}`)).status()).toBe(404);
});
