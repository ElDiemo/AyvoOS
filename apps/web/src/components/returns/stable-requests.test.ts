import { describe, expect, it } from 'vitest';
import { returnsCs } from '@/i18n/cs/returns';
import { ClientApiError } from '@/lib/client-api';
import { errorText } from './stable-requests';

describe('errorText (returns, Po mytí): Czech only, never the server’s raw message', () => {
  it('a known code keeps its own text', () => {
    const code = Object.keys(returnsCs.errors)[0]!;
    expect(errorText(new ClientApiError(409, 'raw', code))).toBe(returnsCs.errors[code]);
  });
  it('refusals without a known code are said by their status', () => {
    const raw = 'scannedValue: Invalid input';
    for (const [status, text] of [
      [400, returnsCs.refused.invalid],
      [422, returnsCs.refused.invalid],
      [403, returnsCs.refused.forbidden],
      [404, returnsCs.refused.notFound],
      [409, returnsCs.refused.other],
    ] as const) {
      const shown = errorText(new ClientApiError(status, raw, 'SOMETHING_NEW'));
      expect(shown).toBe(text);
      expect(shown).not.toContain(raw);
    }
  });
  it('no answer or a server error stays uncertain', () => {
    expect(errorText(new TypeError('fetch failed'))).toBe(returnsCs.uncertain);
    expect(errorText(new ClientApiError(502, 'Bad gateway'))).toBe(returnsCs.uncertain);
  });
});
