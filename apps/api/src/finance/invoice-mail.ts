import {
  AYVO_LOGO_PNG_BASE64,
  AYVO_LOGO_PNG_HEIGHT,
  AYVO_LOGO_PNG_WIDTH,
} from '../common/ayvo-logo-png.js';
import { documentAmount, documentDate, type InvoicePdfSnapshot } from './invoice-pdf.js';

/** The approved sender of invoices (owner 2026-10-30); authentication mail keeps its own. */
export const INVOICE_MAIL_SENDER = { name: 'AYVO Billing', address: 'invoice@ayvo.co' } as const;

const LOGO_CID = 'ayvo-logo@ayvo-os';
// The same colours as the authentication e-mails.
const C = {
  page: '#f5f5f4',
  card: '#ffffff',
  border: '#e7e5e4',
  heading: '#1c1917',
  body: '#44403c',
  muted: '#78716c',
  testBg: '#b42318',
};
const FONT = 'font-family:Arial,Helvetica,sans-serif';
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface InvoiceMail {
  subject: string;
  text: string;
  html: string;
  filename: string;
}

/**
 * The e-mail of an invoice, only from the invoice's own snapshot, so it always matches the PDF: its
 * language and texts as frozen at issuing, no VAT or legal wording. A TEST invoice says so in the
 * subject and at the top of both versions.
 */
export function renderInvoiceMail(s: InvoicePdfSnapshot): InvoiceMail {
  const t = s.texts;
  const m = t.mail;
  const test = s.environment === 'TEST';
  const period = `${s.period.slice(5)}/${s.period.slice(0, 4)}`;
  const intro = m.intro.replace('{number}', s.number).replace('{period}', period);
  const facts: [string, string][] = [
    [t.amount, `${documentAmount(s.language, s.totals.total)} ${s.totals.currency}`],
    [t.dueOn, documentDate(s.language, s.dueOn)],
    [t.variableSymbol, s.payment.variableSymbol],
  ];
  const subject = `${test ? `${m.testSubjectPrefix} ` : ''}${t.invoice} ${s.number}`;
  const text = [
    ...(test ? [m.testNotice, ''] : []),
    m.greeting,
    '',
    intro,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    m.reply,
    '',
    m.signature,
    s.issuer.legalName,
  ].join('\n');
  const row = ([k, v]: [string, string]) =>
    `<tr><td style="${FONT};font-size:14px;color:${C.muted};padding:4px 16px 4px 0;">${escape(k)}</td><td style="${FONT};font-size:14px;color:${C.heading};padding:4px 0;font-weight:bold;">${escape(v)}</td></tr>`;
  const html = `<!doctype html>
<html lang="${s.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.border};border-radius:8px;">
${test ? `<tr><td style="${FONT};font-size:13px;font-weight:bold;color:#ffffff;background:${C.testBg};padding:10px 24px;border-radius:8px 8px 0 0;">${escape(m.testNotice)}</td></tr>` : ''}
<tr><td style="padding:24px 24px 8px;"><img src="cid:${LOGO_CID}" width="${Math.round(AYVO_LOGO_PNG_WIDTH / 2)}" height="${Math.round(AYVO_LOGO_PNG_HEIGHT / 2)}" alt="AYVO" style="display:block;border:0;"></td></tr>
<tr><td style="${FONT};font-size:15px;line-height:22px;color:${C.body};padding:8px 24px;">
<p style="margin:0 0 12px;">${escape(m.greeting)}</p>
<p style="margin:0 0 16px;">${escape(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0">${facts.map(row).join('')}</table>
<p style="margin:16px 0 0;">${escape(m.reply)}</p>
</td></tr>
<tr><td style="${FONT};font-size:13px;line-height:20px;color:${C.muted};padding:16px 24px 24px;">${escape(m.signature)}<br>${escape(s.issuer.legalName)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html, filename: `${t.filePrefix}-${s.number}.pdf` };
}

export const invoiceMailLogo = () => ({
  filename: 'ayvo-logo.png',
  content: Buffer.from(AYVO_LOGO_PNG_BASE64, 'base64'),
  contentType: 'image/png',
  cid: LOGO_CID,
});
