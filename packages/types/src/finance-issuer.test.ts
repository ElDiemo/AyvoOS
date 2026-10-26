import { describe, expect, it } from 'vitest';
import {
  czAccountValid,
  czIban,
  ibanValid,
  issuerBankAccountFieldsSchema,
  issuerFieldsSchema,
  normalizeIban,
} from './finance-issuer.js';

const account = (over: Record<string, unknown> = {}) => ({
  label: 'Hlavní účet (test)',
  currency: 'CZK',
  accountPrefix: '19',
  accountNumber: '2000145399',
  bankCode: '0800',
  iban: 'CZ65 0800 0000 1920 0014 5399',
  bic: 'GIBACZPX',
  ...over,
});

describe('invoice bank account checks (N3A-2a)', () => {
  it('IBAN: mod 97 and the Czech length; spaces and case normalized first', () => {
    expect(ibanValid('CZ6508000000192000145399')).toBe(true);
    expect(ibanValid('CZ0801000000192000145399')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('CZ6508000000192000145398')).toBe(false); // one digit off
    expect(ibanValid('CZ650800000019200014539')).toBe(false); // CZ is 24 characters
    expect(ibanValid('cz6508000000192000145399')).toBe(false);
    expect(normalizeIban(' cz65 0800 0000 1920 0014 5399 ')).toBe('CZ6508000000192000145399');
  });

  it('Czech domestic number: ČNB weights for prefix and number; its IBAN is derived exactly', () => {
    expect(czAccountValid('19', '2000145399')).toBe(true);
    expect(czAccountValid(null, '2000145399')).toBe(true);
    expect(czAccountValid('19', '2000145398')).toBe(false);
    expect(czAccountValid('18', '2000145399')).toBe(false);
    expect(czAccountValid(null, '0000000000')).toBe(false);
    expect(czIban('19', '2000145399', '0800')).toBe('CZ6508000000192000145399');
    expect(czIban('000019', '2000145399', '0100')).toBe('CZ0801000000192000145399');
  });

  it('the form: domestic number and IBAN must agree; number and bank code go together; BIC format', () => {
    const ok = issuerBankAccountFieldsSchema.parse(account());
    expect(ok).toMatchObject({
      iban: 'CZ6508000000192000145399',
      bic: 'GIBACZPX',
      accountPrefix: '19',
    });
    for (const bad of [
      { iban: 'CZ0801000000192000145399' }, // another bank than the domestic number
      { bankCode: null },
      { accountNumber: '2000145398' },
      { bic: 'GIBA' },
      { iban: 'CZ65 0800 0000 1920 0014 5398' },
    ])
      expect(
        issuerBankAccountFieldsSchema.safeParse(account(bad)).success,
        JSON.stringify(bad),
      ).toBe(false);
    // A foreign account by IBAN only.
    expect(
      issuerBankAccountFieldsSchema.safeParse(
        account({
          currency: 'EUR',
          accountPrefix: null,
          accountNumber: null,
          bankCode: null,
          iban: 'DE89370400440532013000',
          bic: '',
        }),
      ).success,
    ).toBe(true);
  });

  it('the issuer: VAT status is explicit; a VAT payer needs DIČ; a Czech IČO has 8 digits', () => {
    const base = {
      legalName: 'Testovací firma s.r.o.',
      addressLine1: 'Testovací 1',
      postalCode: '110 00',
      city: 'Praha',
      countryCode: 'CZ',
      companyId: '12345678',
      vatStatus: 'NOT_VAT_PAYER',
      email: 'fakturace@firma.test',
    };
    expect(issuerFieldsSchema.safeParse(base).success).toBe(true);
    expect(issuerFieldsSchema.safeParse({ ...base, vatStatus: undefined }).success).toBe(false);
    expect(issuerFieldsSchema.safeParse({ ...base, vatStatus: 'VAT_PAYER' }).success).toBe(false);
    expect(
      issuerFieldsSchema.safeParse({ ...base, vatStatus: 'VAT_PAYER', vatId: 'CZ12345678' })
        .success,
    ).toBe(true);
    expect(issuerFieldsSchema.safeParse({ ...base, companyId: '1234' }).success).toBe(false);
  });
});
