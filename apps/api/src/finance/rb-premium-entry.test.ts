import { describe, expect, it } from 'vitest';
import { exactMoney, parseTransactionPage, UnexpectedBankAnswer } from './rb-premium-entry.js';

const page = (tx: string, lastPage = 'true') => `{"lastPage":${lastPage},"transactions":[${tx}]}`;
const tx = (amount: string, extra = '') =>
  `{"entryReference":"E1","amount":{"value":${amount},"currency":"CZK"},"creditDebitIndication":"CRDT","bankTransactionCode":{"code":"10000405000"}${extra}}`;

describe('RB Premium transaction list parsing (doc 041)', () => {
  it('amounts are read from the exact text, never through a float; more than 2 decimals is refused', () => {
    expect(exactMoney('1500.5')).toBe('1500.50');
    expect(exactMoney('-1668.59')).toBe('-1668.59');
    expect(exactMoney('0.1')).toBe('0.10');
    expect(exactMoney('7')).toBe('7.00');
    expect(exactMoney('1.100')).toBe('1.10');
    expect(exactMoney('-0.00')).toBe('0.00');
    expect(exactMoney('12345678901234567.89')).toBe('12345678901234567.89');
    for (const bad of ['1.005', '1e3', '0x10', '', '1.'])
      expect(() => exactMoney(bad)).toThrow(UnexpectedBankAnswer);
    // 0.1 + 0.2 style float artefacts never appear: the source text is kept.
    expect(() => parseTransactionPage(page(tx('0.30000000000000004')))).toThrow(/2 decimals/);
  });

  it('the content hash ignores key order and keeps numbers as sent; a numeric reference is its text', () => {
    const a = parseTransactionPage(page(tx('1.10'))).entries[0]!;
    const reordered = `{"bankTransactionCode":{"code":"10000405000"},"creditDebitIndication":"CRDT","amount":{"currency":"CZK","value":1.10},"entryReference":"E1"}`;
    const b = parseTransactionPage(page(reordered)).entries[0]!;
    expect(b.contentSha256).toBe(a.contentSha256);
    expect(a.raw).toContain('"value":1.10');
    expect(parseTransactionPage(page(tx('1.1'))).entries[0]!.contentSha256).not.toBe(
      a.contentSha256,
    );
    const numeric = tx('5').replace('"entryReference":"E1"', '"entryReference":3887196517');
    expect(parseTransactionPage(page(numeric)).entries[0]!.entryReference).toBe('3887196517');
  });

  it('symbols keep leading zeros; the documented nesting is read; anything else refuses the page', () => {
    const e = parseTransactionPage(
      page(
        tx(
          '10',
          ',"entryDetails":{"transactionDetails":{"remittanceInformation":{"unstructured":" Platba ","creditorReferenceInformation":{"variable":"0012345","constant":"0308"}}}}',
        ),
      ),
    ).entries[0]!;
    expect(e).toMatchObject({
      variableSymbol: '0012345',
      constantSymbol: '0308',
      message: 'Platba',
    });
    expect(parseTransactionPage('{"transactions":[]}').lastPage).toBe(false);
    for (const bad of [
      '<html>',
      '{"lastPage":true}',
      page(tx('1').replace('"CRDT"', '"CREDIT"')),
      page(tx('"1.00"')),
      page(tx('1').replace('"currency":"CZK"', '"currency":"czk"')),
    ])
      expect(() => parseTransactionPage(bad), bad).toThrow(UnexpectedBankAnswer);
  });
});
