import { z } from 'zod';
import { currencySchema } from './finance.js';

/**
 * Our company as the issuer of invoices and the bank accounts printed on them (N3A-2a, doc 040
 * §8). Finance is the only place these are kept (a site is not a legal entity, doc 022 §1). Every
 * change is a new version with its author and reason; an issued invoice keeps its own snapshot
 * (N3A-2b), so a later change never alters an issued PDF or its QR payment. The invoice recipient
 * account is NOT the bank connection used to read transactions (doc 041).
 */

// --- account number checks (pure; shared by the API and the forms) --------------------------

const digits = (s: string) => /^\d+$/.test(s);

/** ISO 13616: country + 2 check digits + BBAN, mod 97 = 1. Spaces are not allowed (normalize first). */
export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('CZ') && iban.length !== 24) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** Czech domestic account (ČNB decree 169/2011): weighted sums of prefix and number divisible by 11. */
export function czAccountValid(prefix: string | null, number: string): boolean {
  const p = prefix ?? '';
  if (
    (p && (!digits(p) || p.length > 6)) ||
    !digits(number) ||
    number.length < 2 ||
    number.length > 10
  )
    return false;
  const weighted = (s: string, weights: number[]) =>
    [...s.padStart(weights.length, '0')].reduce((sum, d, i) => sum + Number(d) * weights[i]!, 0);
  return (
    weighted(p, [10, 5, 8, 4, 2, 1]) % 11 === 0 &&
    weighted(number, [6, 3, 7, 9, 10, 5, 8, 4, 2, 1]) % 11 === 0 &&
    /[1-9]/.test(number)
  );
}

/** The IBAN of a Czech domestic account ("CZkk" + bank 4 + prefix 6 + number 10). */
export function czIban(prefix: string | null, number: string, bankCode: string): string {
  const bban = `${bankCode}${(prefix ?? '').padStart(6, '0')}${number.padStart(10, '0')}`;
  let rest = 0;
  for (const d of `${bban}123500`) rest = (rest * 10 + Number(d)) % 97; // "CZ00" → 12 35 00
  return `CZ${String(98 - rest).padStart(2, '0')}${bban}`;
}

/** Upper-case, without spaces (as people copy it from internet banking). */
export const normalizeIban = (v: string) => v.replace(/\s+/g, '').toUpperCase();

// --- the issuer ------------------------------------------------------------------------------

/** Explicit — there is no default: an unknown VAT status blocks live issuing. */
export const VAT_STATUSES = ['VAT_PAYER', 'NOT_VAT_PAYER'] as const;
export const vatStatusSchema = z.enum(VAT_STATUSES);
export type VatStatus = z.infer<typeof vatStatusSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);
const reasonSchema = z.string().trim().min(1, 'Uveďte důvod.').max(500);

export const issuerFieldsSchema = z
  .object({
    legalName: text(200),
    addressLine1: text(200),
    addressLine2: optionalText(200),
    postalCode: text(20),
    city: text(100),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, 'Země: dvě velká písmena (např. CZ).'),
    /** IČO (a Czech one: 8 digits). */
    companyId: text(30),
    vatStatus: vatStatusSchema,
    /** DIČ; required for a VAT payer. */
    vatId: optionalText(30),
    /** E.g. "C 123456 vedená u Městského soudu v Praze" — wording as the accountant confirms. */
    registration: optionalText(300),
    email: z.email('Neplatný e-mail.').max(254),
    phone: optionalText(40),
    web: optionalText(200),
  })
  .refine((c) => c.countryCode !== 'CZ' || /^\d{8}$/.test(c.companyId), {
    message: 'IČO v ČR má 8 číslic.',
    path: ['companyId'],
  })
  .refine((c) => c.vatStatus !== 'VAT_PAYER' || c.vatId !== null, {
    message: 'Plátce DPH musí mít DIČ.',
    path: ['vatId'],
  });
export type IssuerFields = z.infer<typeof issuerFieldsSchema>;

export const newIssuerVersionSchema = z.object({
  requestId: z.uuid(),
  /** The version the form was loaded from; 0 = there is none yet. */
  expectedVersion: z.number().int().min(0),
  issuer: issuerFieldsSchema,
  reason: reasonSchema,
});
export type NewIssuerVersionRequest = z.infer<typeof newIssuerVersionSchema>;

const recorded = {
  reason: z.string(),
  recordedAt: z.iso.datetime(),
  recordedByName: z.string(),
};

export const issuerVersionSchema = z.object({
  version: z.number().int(),
  issuer: z.object({
    legalName: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    postalCode: z.string(),
    city: z.string(),
    countryCode: z.string(),
    companyId: z.string(),
    vatStatus: vatStatusSchema,
    vatId: z.string().nullable(),
    registration: z.string().nullable(),
    email: z.string(),
    phone: z.string().nullable(),
    web: z.string().nullable(),
  }),
  ...recorded,
});
export type IssuerVersion = z.infer<typeof issuerVersionSchema>;

// --- bank accounts on invoices -------------------------------------------------------------

export const issuerBankAccountFieldsSchema = z
  .object({
    label: text(100),
    currency: currencySchema,
    /** Czech domestic form (optional for foreign accounts). */
    accountPrefix: optionalText(6),
    accountNumber: optionalText(10),
    bankCode: optionalText(4),
    iban: z.string().transform(normalizeIban).pipe(z.string().refine(ibanValid, 'Neplatný IBAN.')),
    bic: z
      .string()
      .trim()
      .toUpperCase()
      .transform((v) => (v === '' ? null : v))
      .pipe(
        z
          .string()
          .regex(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'Neplatný BIC.')
          .nullable(),
      )
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  })
  .superRefine((a, ctx) => {
    const domestic = [a.accountNumber, a.bankCode].filter((v) => v !== null).length;
    if (domestic === 1 || (a.accountPrefix !== null && domestic === 0))
      ctx.addIssue({
        code: 'custom',
        path: ['accountNumber'],
        message: 'Číslo účtu a kód banky se vyplňují společně.',
      });
    if (a.accountNumber !== null && a.bankCode !== null) {
      if (!/^\d{4}$/.test(a.bankCode))
        ctx.addIssue({ code: 'custom', path: ['bankCode'], message: 'Kód banky má 4 číslice.' });
      else if (!czAccountValid(a.accountPrefix, a.accountNumber))
        ctx.addIssue({
          code: 'custom',
          path: ['accountNumber'],
          message: 'Číslo účtu neprošlo kontrolou (předčíslí / číslo).',
        });
      else if (czIban(a.accountPrefix, a.accountNumber, a.bankCode) !== a.iban)
        ctx.addIssue({
          code: 'custom',
          path: ['iban'],
          message: 'IBAN neodpovídá číslu účtu a kódu banky.',
        });
    }
  });
export type IssuerBankAccountFields = z.infer<typeof issuerBankAccountFieldsSchema>;

export const createIssuerBankAccountSchema = z.object({
  requestId: z.uuid(),
  account: issuerBankAccountFieldsSchema,
  reason: reasonSchema,
});
export type CreateIssuerBankAccountRequest = z.infer<typeof createIssuerBankAccountSchema>;

export const newIssuerBankAccountVersionSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  /** RETIRED = no longer offered (never deleted); ACTIVE again only by a new version. */
  status: z.enum(['ACTIVE', 'RETIRED']),
  account: issuerBankAccountFieldsSchema,
  reason: reasonSchema,
});
export type NewIssuerBankAccountVersionRequest = z.infer<typeof newIssuerBankAccountVersionSchema>;

export const issuerBankAccountVersionSchema = z.object({
  version: z.number().int(),
  status: z.enum(['ACTIVE', 'RETIRED']),
  account: z.object({
    label: z.string(),
    currency: z.string(),
    accountPrefix: z.string().nullable(),
    accountNumber: z.string().nullable(),
    bankCode: z.string().nullable(),
    iban: z.string(),
    bic: z.string().nullable(),
  }),
  ...recorded,
});
export type IssuerBankAccountVersion = z.infer<typeof issuerBankAccountVersionSchema>;

export const issuerBankAccountSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  current: issuerBankAccountVersionSchema,
  versions: z.array(issuerBankAccountVersionSchema),
});
export type IssuerBankAccount = z.infer<typeof issuerBankAccountSchema>;

/** The default account for a currency (one per currency; a choice, versioned by revision). */
export const setDefaultAccountSchema = z.object({
  requestId: z.uuid(),
  currency: currencySchema,
  accountCode: z.string().regex(/^IB-\d{6,}$/),
  /** The current choice's revision the form saw; null = none yet. */
  expectedRevision: z.number().int().min(1).nullable(),
  reason: reasonSchema,
});
export type SetDefaultAccountRequest = z.infer<typeof setDefaultAccountSchema>;

export const defaultAccountSchema = z.object({
  currency: z.string(),
  accountCode: z.string(),
  revision: z.number().int(),
  ...recorded,
});
export type DefaultAccount = z.infer<typeof defaultAccountSchema>;

/**
 * What still blocks a live invoice in a currency (never development or synthetic tests). Only
 * facts of this setting; accounting rules (VAT rates, numbering, wording) are separate gates.
 */
export const ISSUER_GAPS = [
  'ISSUER_MISSING',
  'NO_DEFAULT_ACCOUNT',
  'DEFAULT_ACCOUNT_RETIRED',
] as const;
export const issuerGapSchema = z.enum(ISSUER_GAPS);
export type IssuerGap = z.infer<typeof issuerGapSchema>;

export const issuerSettingsSchema = z.object({
  current: issuerVersionSchema.nullable(),
  versions: z.array(issuerVersionSchema),
  accounts: z.array(issuerBankAccountSchema),
  defaults: z.array(defaultAccountSchema),
  /** Per currency used by an account or a default: what blocks live issuing. */
  readiness: z.array(z.object({ currency: z.string(), gaps: z.array(issuerGapSchema) })),
});
export type IssuerSettings = z.infer<typeof issuerSettingsSchema>;
