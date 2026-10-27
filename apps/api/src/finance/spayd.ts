import { ibanValid } from '@ayvo/types';

/**
 * QR Platba — the Czech Banking Association's Short Payment Descriptor (SPAYD 1.0, qr-platba.cz,
 * read 2026-10-26). Built locally from an issued invoice's own snapshot, never by an external
 * service. Only the keys every Czech bank processes for a domestic payment are used: ACC (one
 * account), AM, CC (CZK only), DT, MSG, X-VS. Nothing is shortened silently: a value that does not
 * fit the format is refused, so the code always says exactly what the invoice says.
 */
export interface PaymentInstruction {
  /** The recipient account as printed on the invoice. */
  iban: string;
  bic: string | null;
  /** Exact decimal string, e.g. "1500.50" — never a float. */
  amount: string;
  currency: string;
  /** Digits only, leading zeros kept (e.g. "0012345"). */
  variableSymbol: string | null;
  /** Due date "YYYY-MM-DD". */
  dueDate: string | null;
  message: string | null;
}

export class InvalidPaymentInstruction extends Error {}

const fail = (why: string): never => {
  throw new InvalidPaymentInstruction(why);
};

/** A free text for the descriptor: no "*" (encoded %2A), no line breaks, at most `max` characters. */
function text(value: string, max: number, key: string): string {
  // No whitespace may follow ":" or precede "*" — trimmed, as printed.
  const v = value.trim();
  if (/[\r\n]/.test(v)) fail(`${key} contains a line break`);
  // ISO-8859-1 only (the standard's character set); Czech letters outside it are refused, never changed.
  if (/[^\u0020-\u007e\u00a0-\u00ff]/.test(v)) fail(`${key} has characters outside ISO-8859-1`);
  const encoded = v.replace(/%/g, '%25').replace(/\*/g, '%2A');
  // The limit applies to the value as transmitted.
  if (encoded.length > max) fail(`${key} is longer than ${max} characters`);
  return encoded;
}

export function spayd(p: PaymentInstruction): string {
  if (p.currency !== 'CZK') fail('QR Platba is issued for CZK only');
  if (!ibanValid(p.iban)) fail('invalid IBAN');
  if (p.bic !== null && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(p.bic)) fail('invalid BIC');
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(p.amount);
  if (!m) fail('amount must be a decimal with at most 2 decimals and at most 9 999 999.99');
  const amount = `${m![1]!.replace(/^0+(?=\d)/, '')}.${(m![2] ?? '').padEnd(2, '0')}`;
  if (!/[1-9]/.test(amount)) fail('amount must be greater than zero');
  const parts = [`ACC:${p.iban}${p.bic ? `+${p.bic}` : ''}`, `AM:${amount}`, 'CC:CZK'];
  if (p.dueDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) fail('due date must be YYYY-MM-DD');
    parts.push(`DT:${p.dueDate.replace(/-/g, '')}`);
  }
  if (p.message !== null && p.message.trim() !== '')
    parts.push(`MSG:${text(p.message, 60, 'MSG')}`);
  if (p.variableSymbol !== null) {
    if (!/^\d{1,10}$/.test(p.variableSymbol)) fail('variable symbol: 1–10 digits');
    parts.push(`X-VS:${p.variableSymbol}`);
  }
  return `SPD*1.0*${parts.join('*')}`;
}
