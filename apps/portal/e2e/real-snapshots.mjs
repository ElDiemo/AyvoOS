// Screenshots of portal-web pages in Chromium at 390 and 1440 px, with a given portal session, for
// the walk against the REAL core and Finance (apps/api/test/portal-web-walk.e2e.test.ts). Any CSP
// violation or page error fails the run. Synthetic accounts only; nothing is traced or recorded
// beyond the screenshots written to the output directory.
//   node e2e/real-snapshots.mjs '<json: {base, out, shots: [{name, session|null, path}]}>'
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const { base, out, shots } = JSON.parse(process.argv[2]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const problems = [];
try {
  for (const width of [390, 1440]) {
    for (const shot of shots) {
      // The walk's edge uses a certificate made for that run only.
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        ignoreHTTPSErrors: true,
      });
      if (shot.session)
        await context.addCookies([
          {
            name: '__Host-ayvo_portal',
            value: shot.session,
            url: base,
            httpOnly: true,
            secure: true,
            sameSite: 'Strict',
          },
        ]);
      const page = await context.newPage();
      await page.addInitScript(() =>
        document.addEventListener('securitypolicyviolation', (e) =>
          console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
        ),
      );
      page.on('console', (m) => {
        if (/CSP violation|Content Security Policy/i.test(m.text()))
          problems.push(`${shot.name}@${width}: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`${shot.name}@${width}: ${e.message}`));
      const res = await page.goto(`${base}${shot.path}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(out, `${shot.name}-${width}.png`), fullPage: true });
      console.log(`${shot.name}-${width}.png ${res?.status()} ${new URL(page.url()).pathname}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
