import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { googleRelayOptions } from '../common/google-smtp-relay.js';
import type { FinanceEnv } from './finance-env.js';
import { invoiceMailLogo, type InvoiceMail } from './invoice-mail.js';

export interface OutgoingInvoiceMail extends InvoiceMail {
  from: { name: string; address: string };
  replyTo: string;
  to: string;
  messageId: string;
  pdf: Buffer;
}

/**
 * What happened to one message:
 * - ACCEPTED: the relay took it (not "in the mailbox");
 * - REJECTED: the relay refused it for good, nothing was accepted;
 * - NOT_SENT: provably nothing left (no connection, or a temporary refusal): may stay queued;
 * - UNCERTAIN: anything else, above all a connection lost mid-way. Never retried automatically.
 */
export type SendOutcome =
  { kind: 'ACCEPTED' } | { kind: 'REJECTED' | 'NOT_SENT' | 'UNCERTAIN'; code: string };

export interface InvoiceMailTransport {
  send(mail: OutgoingInvoiceMail): Promise<SendOutcome>;
}

/** Everything unknown is UNCERTAIN: only an explicit answer or no connection proves no message. */
export function classifySmtpError(e: unknown): SendOutcome {
  const err = (e ?? {}) as { code?: string; syscall?: string; responseCode?: number };
  if (typeof err.responseCode === 'number') {
    const family = Math.floor(err.responseCode / 100);
    if (family === 5) return { kind: 'REJECTED', code: `RELAY_${err.responseCode}` };
    if (family === 4) return { kind: 'NOT_SENT', code: `RELAY_${err.responseCode}` };
    return { kind: 'UNCERTAIN', code: `RELAY_${err.responseCode}` };
  }
  // Only a connection that was never made proves it. nodemailer's `command` is no proof: a socket
  // closed after the message was written still reports CONN.
  if (err.syscall === 'connect' || err.code === 'EDNS' || err.code === 'ETLS')
    return { kind: 'NOT_SENT', code: 'RELAY_UNREACHABLE' };
  return { kind: 'UNCERTAIN', code: 'CONNECTION_LOST' };
}

/** A whole sending ends by this deadline; the lease on the record is longer. */
const SEND_DEADLINE_MS = 60_000;
export const SEND_LEASE_MS = 120_000;

class SmtpInvoiceMailTransport implements InvoiceMailTransport {
  private readonly smtp: Transporter;

  constructor(options: SMTPTransport.Options) {
    // One connection per message, none kept open; the runner sends one message at a time.
    this.smtp = nodemailer.createTransport({ ...options, socketTimeout: 30_000 });
  }

  async send(mail: OutgoingInvoiceMail): Promise<SendOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = (await Promise.race([
        this.smtp.sendMail({
          from: mail.from,
          replyTo: mail.replyTo,
          to: mail.to,
          messageId: mail.messageId,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          attachments: [
            invoiceMailLogo(),
            { filename: mail.filename, content: mail.pdf, contentType: 'application/pdf' },
          ],
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('deadline')), SEND_DEADLINE_MS);
        }),
      ])) as { accepted?: unknown[] };
      if (!info.accepted?.length) return { kind: 'REJECTED', code: 'RECIPIENT_REFUSED' };
      return { kind: 'ACCEPTED' };
    } catch (e) {
      return classifySmtpError(e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Never opens a connection (tests and the DEV simulation): keeps the latest messages; special domains
 * stand for the relay's other answers.
 */
export class MemoryInvoiceMailTransport implements InvoiceMailTransport {
  readonly sent: OutgoingInvoiceMail[] = [];

  send(mail: OutgoingInvoiceMail): Promise<SendOutcome> {
    if (mail.to.endsWith('@odmitnuto.test'))
      return Promise.resolve({ kind: 'REJECTED', code: 'RELAY_550' });
    if (mail.to.endsWith('@nejiste.test'))
      return Promise.resolve({ kind: 'UNCERTAIN', code: 'CONNECTION_LOST' });
    this.sent.push(mail);
    if (this.sent.length > MEMORY_KEEP) this.sent.shift();
    return Promise.resolve({ kind: 'ACCEPTED' });
  }
}

const MEMORY_KEEP = 100;

export const INVOICE_MAIL_TRANSPORT = Symbol('INVOICE_MAIL_TRANSPORT');

export function createInvoiceMailTransport(env: FinanceEnv): InvoiceMailTransport | null {
  if (env.FINANCE_INVOICE_MAIL === 'google-relay')
    return new SmtpInvoiceMailTransport(googleRelayOptions(env.FINANCE_MAIL_EHLO_NAME!));
  if (env.FINANCE_INVOICE_MAIL === 'test-smtp') {
    const [host, port] = env.FINANCE_MAIL_TEST_SMTP_ADDRESS!.split(':');
    return new SmtpInvoiceMailTransport({
      host,
      port: Number(port),
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 2_000,
      greetingTimeout: 2_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  if (env.FINANCE_INVOICE_MAIL === 'memory' || env.FINANCE_INVOICE_MAIL === 'simulation')
    return new MemoryInvoiceMailTransport();
  return null;
}
