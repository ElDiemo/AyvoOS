import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AYVO_LOGO_CID, ayvoLogoAttachment, pragueTime, renderAuthMail } from './auth-mail.js';
import { AYVO_LOGO_PNG_HEIGHT, AYVO_LOGO_PNG_WIDTH } from '../../common/ayvo-logo-png.js';

// Synthetic, never a real link: 43 base64url characters like a token, but made up.
const TOKEN = 'SYNTHETIC_not-a-real-token_0123456789abcde';
const DEV_URL = `https://dev.ayvo.co/activate#token=${TOKEN}`;
const PROD_URL = `https://os.ayvo.co/reset-password#token=${TOKEN}`;
const EXPIRES = new Date('2026-10-31T13:35:06.000Z');

describe('authentication e-mails', () => {
  it('activation: subject, button, exact link in text only, validity in Prague time, DEV marked', () => {
    const mail = renderAuthMail({
      purpose: 'ENROLL',
      url: DEV_URL,
      expiresAt: EXPIRES,
      appEnv: 'development',
    });
    expect(mail.subject).toBe('[DEV] Nastavení přístupu do AYVO OS');
    // The text alternative carries the original one-time link unchanged (fragment, origin, path).
    expect(mail.text.split('\n')).toContain(DEV_URL);
    expect(mail.text).toContain('TESTOVACÍ PROSTŘEDÍ DEV');
    expect(mail.text).toContain('platí do 31. 10. 2026 14:35');
    // HTML: one button with the link in href; the token is not shown as text.
    expect(mail.html).toContain(`<a href="${DEV_URL}"`);
    expect(mail.html).toContain('>Nastavit přístup</a>');
    expect(mail.html.split(TOKEN)).toHaveLength(2);
    expect(mail.html).toContain('<strong style="color:#1c1917;">dev.ayvo.co</strong>');
    expect(mail.html).toContain('TESTOVACÍ PROSTŘEDÍ DEV');
    expect(mail.html).toContain(`src="cid:${AYVO_LOGO_CID}"`);
    expect(mail.html).toContain('alt="AYVO"');
    // No query token, tracker, external image, font, script or form.
    expect(mail.html).not.toMatch(
      /\?token|<script|<form|<link|@import|https?:\/\/(?!dev\.ayvo\.co)/,
    );
  });

  it('password reset on production: no DEV marking, its own origin and copy', () => {
    const mail = renderAuthMail({
      purpose: 'RESET_PASSWORD',
      url: PROD_URL,
      expiresAt: new Date('2026-01-15T09:05:00.000Z'),
      appEnv: 'production',
    });
    expect(mail.subject).toBe('Obnova hesla do AYVO OS');
    expect(mail.text + mail.html).not.toContain('DEV');
    expect(mail.text.split('\n')).toContain(PROD_URL);
    expect(mail.html).toContain('>Obnovit heslo</a>');
    expect(mail.html).toContain('os.ayvo.co');
    expect(mail.text).toContain('platí do 15. 1. 2026 10:05'); // winter time, CET
    expect(mail.text).toContain('heslo zůstane beze změny');
  });

  it('escapes every dynamic value in HTML', () => {
    const url = `https://dev.ayvo.co/activate#token=a"b<c>&d'e`;
    const mail = renderAuthMail({ purpose: 'ENROLL', url, expiresAt: EXPIRES, appEnv: 'test' });
    expect(mail.html).toContain(
      'href="https://dev.ayvo.co/activate#token=a&quot;b&lt;c&gt;&amp;d&#39;e"',
    );
    expect(mail.html).not.toContain('a"b<c>');
  });

  it('Prague time follows daylight saving', () => {
    expect(pragueTime(new Date('2026-07-01T10:00:00Z'))).toBe('1. 7. 2026 12:00');
    expect(pragueTime(new Date('2026-12-01T10:00:00Z'))).toBe('1. 12. 2026 11:00');
  });

  it('the embedded logo is the existing wordmark as PNG, same aspect ratio, inline by CID', () => {
    const logo = ayvoLogoAttachment();
    expect(logo).toMatchObject({
      cid: AYVO_LOGO_CID,
      contentType: 'image/png',
      contentDisposition: 'inline',
    });
    const png = logo.content;
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
      AYVO_LOGO_PNG_WIDTH,
      AYVO_LOGO_PNG_HEIGHT,
    ]);
    const svg = readFileSync(
      resolve(import.meta.dirname, '../../../../web/public/brand/ayvo-wordmark.svg'),
      'utf8',
    );
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg)!;
    expect(
      Math.abs(AYVO_LOGO_PNG_HEIGHT - (AYVO_LOGO_PNG_WIDTH * Number(h)) / Number(w)),
    ).toBeLessThan(1);
  });
});
