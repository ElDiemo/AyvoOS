import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Parsing of the transaction list of Raiffeisenbank Premium API (`getTransactionList`, Swagger
 * v1.1.20240910, read on 2026-10-26 from developers.rb.cz): `{ lastPage, transactions[] }`, each
 * with the required `entryReference`, `amount {value, currency}`, `creditDebitIndication`
 * (CRDT/DBIT) and `bankTransactionCode.code`, the rest optional. Amounts are JSON numbers
 * (`double`): they are read from the exact source text of the answer, never through a float, and
 * more than 2 significant decimals is refused (never rounded). Anything else unexpected refuses
 * the whole page — nothing is guessed.
 */

// JSON.parse source text access (Node ≥ 21); not yet in the TypeScript library.
interface RawJson {
  readonly rawJSON: string;
}
declare global {
  interface JSON {
    rawJSON(text: string): RawJson;
    isRawJSON(value: unknown): value is RawJson;
  }
}
type Reviver = (key: string, value: unknown, context: { source?: string }) => unknown;

export class UnexpectedBankAnswer extends Error {}

/** Parses JSON keeping every number as its exact source text (a RawJson). */
export function parseExact(text: string): unknown {
  const reviver: Reviver = (_k, v, ctx) =>
    typeof v === 'number' && ctx.source !== undefined ? JSON.rawJSON(ctx.source) : v;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}

/** An exact decimal with at most 2 significant decimals, normalized to 2 ("-1668.5" → "-1668.50"). */
export function exactMoney(source: string): string {
  const m = /^(-?)(\d{1,17})(?:\.(\d+))?$/.exec(source);
  if (!m) throw new UnexpectedBankAnswer('amount is not a plain decimal');
  const decimals = m[3] ?? '';
  if (/[^0]/.test(decimals.slice(2)))
    throw new UnexpectedBankAnswer('amount has more than 2 decimals');
  const value = `${m[2]}.${decimals.slice(0, 2).padEnd(2, '0')}`;
  return m[1] && /[1-9]/.test(value) ? `-${value}` : value;
}

const rawNumber = z.custom<RawJson>((v) => JSON.isRawJSON(v), 'a number');
const money = z.object({ value: rawNumber, currency: z.string().regex(/^[A-Z]{3}$/) });
const text = z.string().max(2_000).optional();
const dateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'a date-time')
  .optional();

const entrySchema = z.object({
  entryReference: z
    .union([z.string(), rawNumber])
    .transform((v) => (typeof v === 'string' ? v : v.rawJSON))
    .pipe(z.string().min(1).max(100)),
  amount: money,
  creditDebitIndication: z.enum(['CRDT', 'DBIT']),
  bookingDate: dateTime,
  valueDate: dateTime,
  bankTransactionCode: z.object({ code: z.string().min(1).max(50) }),
  entryDetails: z
    .object({
      transactionDetails: z
        .object({
          references: z.object({ endToEndIdentification: text }).optional(),
          instructedAmount: money.extend({ exchangeRate: rawNumber.optional() }).optional(),
          relatedParties: z
            .object({
              counterParty: z
                .object({
                  name: text,
                  organisationIdentification: z.object({ bankCode: text }).optional(),
                  account: z
                    .object({ iban: text, accountNumberPrefix: text, accountNumber: text })
                    .optional(),
                })
                .optional(),
            })
            .optional(),
          remittanceInformation: z
            .object({
              unstructured: text,
              creditorReferenceInformation: z
                .object({ variable: text, constant: text, specific: text })
                .optional(),
              originatorMessage: text,
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const pageSchema = z.object({
  lastPage: z.boolean().optional(),
  transactions: z.array(z.unknown()).max(10_000),
});

export interface BankEntry {
  entryReference: string;
  amount: string;
  amountCurrency: string;
  creditDebit: 'CRDT' | 'DBIT';
  bookingDate: Date | null;
  valueDate: Date | null;
  bankTransactionCode: string;
  endToEndId: string | null;
  counterpartyName: string | null;
  counterpartyAccountPrefix: string | null;
  counterpartyAccountNumber: string | null;
  counterpartyBankCode: string | null;
  counterpartyIban: string | null;
  variableSymbol: string | null;
  constantSymbol: string | null;
  specificSymbol: string | null;
  message: string | null;
  originatorMessage: string | null;
  instructedAmount: string | null;
  instructedCurrency: string | null;
  /** The entry as received, canonical JSON (sorted keys, numbers as sent). */
  raw: string;
  contentSha256: string;
}

/** Canonical JSON: keys sorted, numbers exactly as sent. */
function canonical(v: unknown): string {
  if (JSON.isRawJSON(v)) return v.rawJSON;
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());

/** One page of the transaction list; throws UnexpectedBankAnswer on anything not in the contract. */
export function parseTransactionPage(body: string): { lastPage: boolean; entries: BankEntry[] } {
  let tree: unknown;
  try {
    tree = parseExact(body);
  } catch {
    throw new UnexpectedBankAnswer('the answer is not JSON');
  }
  const page = pageSchema.safeParse(tree);
  if (!page.success) throw new UnexpectedBankAnswer('the answer has no transaction list');
  const entries = page.data.transactions.map((raw, i) => {
    const e = entrySchema.safeParse(raw);
    if (!e.success)
      throw new UnexpectedBankAnswer(
        `transaction ${i + 1}: ${e.error.issues[0]?.path.join('.') || 'shape'} not as documented`,
      );
    const d = e.data.entryDetails?.transactionDetails;
    const party = d?.relatedParties?.counterParty;
    const remittance = d?.remittanceInformation;
    const symbols = remittance?.creditorReferenceInformation;
    const rawText = canonical(raw);
    return {
      entryReference: e.data.entryReference,
      amount: exactMoney(e.data.amount.value.rawJSON),
      amountCurrency: e.data.amount.currency,
      creditDebit: e.data.creditDebitIndication,
      bookingDate: e.data.bookingDate ? new Date(e.data.bookingDate) : null,
      valueDate: e.data.valueDate ? new Date(e.data.valueDate) : null,
      bankTransactionCode: e.data.bankTransactionCode.code,
      endToEndId: blank(d?.references?.endToEndIdentification),
      counterpartyName: blank(party?.name),
      counterpartyAccountPrefix: blank(party?.account?.accountNumberPrefix),
      counterpartyAccountNumber: blank(party?.account?.accountNumber),
      counterpartyBankCode: blank(party?.organisationIdentification?.bankCode),
      counterpartyIban: blank(party?.account?.iban),
      variableSymbol: blank(symbols?.variable),
      constantSymbol: blank(symbols?.constant),
      specificSymbol: blank(symbols?.specific),
      message: blank(remittance?.unstructured),
      originatorMessage: blank(remittance?.originatorMessage),
      instructedAmount: d?.instructedAmount ? exactMoney(d.instructedAmount.value.rawJSON) : null,
      instructedCurrency: d?.instructedAmount?.currency ?? null,
      raw: rawText,
      contentSha256: createHash('sha256').update(rawText).digest('hex'),
    } satisfies BankEntry;
  });
  return { lastPage: page.data.lastPage ?? false, entries };
}
