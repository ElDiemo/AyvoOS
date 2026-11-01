import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrencyInput } from './currency-input';

const html = (value: string) =>
  renderToStaticMarkup(createElement(CurrencyInput, { value, onChange: () => {} }));

describe('the currency of a contract or a price', () => {
  it('any valid code can be typed: no closed list, the usual ones only suggested', () => {
    const out = html('USD');
    expect(out).not.toContain('<select');
    expect(out).toContain('value="USD"');
    expect(out).toContain('pattern="[A-Z]{3}"');
    for (const code of ['CZK', 'EUR']) expect(out).toContain(`<option value="${code}"`);
  });
});
