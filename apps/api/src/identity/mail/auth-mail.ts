import type { NativeActionPurpose } from '../native-credentials.js';
import {
  AYVO_LOGO_PNG_BASE64,
  AYVO_LOGO_PNG_HEIGHT,
  AYVO_LOGO_PNG_WIDTH,
} from './ayvo-logo-png.js';

/**
 * The two authentication e-mails (activation / password reset): small versioned templates in
 * code, no editor. HTML is a narrow table layout with inline styles in the colours of the AYVO OS
 * sign-in page; the text/plain part carries the full one-time link for clients without HTML.
 * Every dynamic value is escaped; the link is never shortened, tracked or redirected.
 */
export const AYVO_LOGO_CID = 'ayvo-logo@ayvo-os';

export interface AuthMail {
  subject: string;
  text: string;
  html: string;
}

const COLORS = {
  page: '#f5f5f4', // stone-100
  card: '#ffffff',
  border: '#e7e5e4', // stone-200
  heading: '#1c1917', // stone-900
  body: '#44403c', // stone-700
  muted: '#78716c', // stone-500
  button: '#1c1917', // stone-900, the app's primary button
  devBg: '#fef3c7', // amber-100
  devText: '#78350f', // amber-900
} as const;

const COPY = {
  ENROLL: {
    subject: 'Nastavení přístupu do AYVO OS',
    heading: 'Nastavte si přístup do AYVO OS',
    intro:
      'Správce vám v AYVO OS připravil účet. Zvolíte si heslo a v telefonu nastavíte ověřovací aplikaci; od té doby se budete přihlašovat heslem a kódem z aplikace.',
    button: 'Nastavit přístup',
    fallback: 'Pokud tlačítko nefunguje, požádejte správce AYVO o nový odkaz.',
  },
  RESET_PASSWORD: {
    subject: 'Obnova hesla do AYVO OS',
    heading: 'Obnova hesla do AYVO OS',
    intro:
      'Požádali jste o nové heslo do AYVO OS. Ověřovací aplikace v telefonu zůstává nastavená a při dokončení obnovy zadáte i její kód.',
    button: 'Obnovit heslo',
    fallback:
      'Pokud tlačítko nefunguje, vyžádejte si nový odkaz přes „Zapomenuté heslo“ na přihlašovací stránce.',
  },
} as const;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** "31. 10. 2026 14:35" in the company's time zone (timestamps are UTC, shown in Prague). */
export function pragueTime(at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('cs-CZ', {
      timeZone: 'Europe/Prague',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${p.day}. ${p.month}. ${p.year} ${p.hour}:${p.minute}`;
}

export function renderAuthMail(input: {
  purpose: NativeActionPurpose;
  /** The exact one-time link (origin + route + #token=…), used unchanged. */
  url: string;
  expiresAt: Date;
  appEnv: 'development' | 'test' | 'production';
}): AuthMail {
  const copy = COPY[input.purpose];
  const host = new URL(input.url).host;
  const dev = input.appEnv !== 'production';
  const until = pragueTime(input.expiresAt);
  const validity = `Odkaz lze použít jen jednou a platí do ${until} (čas v Praze).`;
  const unexpected =
    input.purpose === 'ENROLL'
      ? 'Pokud jste přístup nečekali, odkaz nepoužívejte, nikomu ho nepředávejte a kontaktujte správce AYVO.'
      : 'Pokud jste o obnovu hesla nežádali, e-mail ignorujte – heslo zůstane beze změny. Odkaz nikomu nepředávejte.';
  const devNote = 'TESTOVACÍ PROSTŘEDÍ DEV – neslouží pro skutečný provoz.';
  const subject = `${dev ? '[DEV] ' : ''}${copy.subject}`;

  const text = [
    ...(dev ? [devNote, ''] : []),
    copy.heading,
    '',
    copy.intro,
    '',
    `${copy.button}:`,
    input.url,
    '',
    validity,
    `Odkaz vede na ${host}. ${unexpected}`,
    '',
    'AYVO OS',
    '',
  ].join('\n');

  const p = (content: string, style = '') =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${COLORS.body};${style}">${content}</p>`;
  const html = `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;">
<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;">
<img src="cid:${AYVO_LOGO_CID}" width="${Math.round(AYVO_LOGO_PNG_WIDTH / 2)}" height="${Math.round(AYVO_LOGO_PNG_HEIGHT / 2)}" alt="AYVO" style="display:block;border:0;outline:none;text-decoration:none;">
${
  dev
    ? `<p style="margin:24px 0 0;padding:8px 12px;border-radius:6px;background:${COLORS.devBg};color:${COLORS.devText};font-size:13px;font-weight:bold;line-height:1.4;">${escape(devNote)}</p>`
    : ''
}
<h1 style="margin:28px 0 12px;font-size:20px;line-height:1.3;font-weight:bold;color:${COLORS.heading};">${escape(copy.heading)}</h1>
${p(escape(copy.intro))}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
<tr><td style="border-radius:6px;background:${COLORS.button};">
<a href="${escape(input.url)}" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${escape(copy.button)}</a>
</td></tr>
</table>
${p(escape(validity))}
${p(`Odkaz vede na <strong style="color:${COLORS.heading};">${escape(host)}</strong>. ${escape(unexpected)}`)}
${p(escape(copy.fallback), `font-size:13px;color:${COLORS.muted};`)}
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${COLORS.muted};">AYVO OS</p>
</td></tr>
</table>
</body>
</html>
`;
  return { subject, text, html };
}

/** The embedded logo: a PNG Buffer from the compiled module (no file or URL access). */
export function ayvoLogoAttachment() {
  return {
    filename: 'ayvo.png',
    content: Buffer.from(AYVO_LOGO_PNG_BASE64, 'base64'),
    contentType: 'image/png',
    cid: AYVO_LOGO_CID,
    contentDisposition: 'inline' as const,
  };
}
