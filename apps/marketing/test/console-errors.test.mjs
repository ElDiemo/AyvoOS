// The browser test's filter of the one expected console error (review MKT69-R2).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withoutExpected } from '../e2e/console-errors.mjs';

const EXPECTED = { text: 'Failed … 404 (Not Found)', url: 'http://127.0.0.1:1/no-such-page' };
const other = { text: 'Failed … 404 (Not Found)', url: 'http://127.0.0.1:1/assets/x.css' };
const csp = { text: 'Refused to load the script', url: 'http://127.0.0.1:1/' };

describe('withoutExpected', () => {
  it('removes exactly the expected error', () => {
    assert.deepEqual(withoutExpected([EXPECTED, csp], EXPECTED), [csp]);
    assert.deepEqual(withoutExpected([{ ...EXPECTED }], EXPECTED), []);
  });

  it('keeps an unrelated error when the expected one is missing (no splice(-1))', () => {
    assert.deepEqual(withoutExpected([csp], EXPECTED), [csp]);
    assert.deepEqual(withoutExpected([other], EXPECTED), [other]);
  });

  it('the same text at another URL is not the expected error', () => {
    assert.deepEqual(withoutExpected([other, EXPECTED], EXPECTED), [other]);
  });

  it('a repeated expected error is not hidden', () => {
    assert.equal(withoutExpected([EXPECTED, { ...EXPECTED }], EXPECTED).length, 2);
  });
});
