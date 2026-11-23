import { describe, expect, it } from 'vitest';
import { crateCorrectionsCs } from '@/i18n/cs/filling';
import { labelingCs } from '@/i18n/cs/labeling';
import { workstationsCs } from '@/i18n/cs/workstations';
import { ClientApiError } from '@/lib/client-api';
import { stationErrorText, workstationErrorText } from './workstation-errors';

const raw = 'scannedValue: Invalid input';
const texts = {
  errors: crateCorrectionsCs.errors,
  notFound: crateCorrectionsCs.errors.NOT_FOUND,
  failed: labelingCs.failed,
  network: labelingCs.network,
};

describe('stationErrorText (station, labelling, filling, crate corrections): never raw text', () => {
  it('a known code keeps its own text', () => {
    expect(stationErrorText(new ClientApiError(409, raw, 'CRATE_FULL'), texts)).toBe(
      crateCorrectionsCs.errors.CRATE_FULL,
    );
  });
  it('without a known code the status decides, and the server’s message is never shown', () => {
    for (const [status, text] of [
      [403, labelingCs.errors.FORBIDDEN],
      [404, crateCorrectionsCs.errors.NOT_FOUND],
      [400, labelingCs.failed],
      [409, labelingCs.failed],
      [503, labelingCs.network],
    ] as const) {
      const shown = stationErrorText(new ClientApiError(status, raw, 'SOMETHING_NEW'), texts);
      expect(shown).toBe(text);
      expect(shown).not.toContain(raw);
    }
    expect(stationErrorText(new TypeError('fetch failed'), texts)).toBe(labelingCs.network);
  });
  it('a special answer (with the details) comes first', () => {
    const e = new ClientApiError(409, raw, 'CRATE_FULL', { crate: 'K-1' });
    expect(
      stationErrorText(e, texts, (x) => `${x.code}:${(x.details as { crate: string }).crate}`),
    ).toBe('CRATE_FULL:K-1');
    expect(stationErrorText(e, texts, () => undefined)).toBe(crateCorrectionsCs.errors.CRATE_FULL);
  });
  it('the workstation screens say an invalid input as such', () => {
    expect(workstationErrorText(new ClientApiError(422, raw))).toBe(workstationsCs.invalid);
    expect(workstationErrorText(new ClientApiError(403, raw))).toBe(
      workstationsCs.errors.FORBIDDEN,
    );
  });
});
