import { describe, expect, it } from 'vitest';
import { financeCs } from './finance';

const { stateOf } = financeCs.invoices.delivery;

describe("what an attempt's result says follows the attempt, not the server", () => {
  it('a simulated attempt never reads as accepted by a mail server', () => {
    expect(stateOf('SIMULATION', 'SENT')).toContain('žádný e-mail neodešel');
    expect(stateOf('SIMULATION', 'SENT')).not.toContain('poštovním serverem');
  });
  it('an attempt through the relay stays accepted by the server, whatever the server does today', () => {
    expect(stateOf('RELAY', 'SENT')).toContain('Přijato poštovním serverem');
    expect(stateOf('RELAY', 'SENT')).not.toContain('simulac');
  });
  it('other states read the same in both modes', () => {
    for (const state of ['QUEUED', 'SENDING', 'FAILED', 'UNCERTAIN'])
      expect(stateOf('SIMULATION', state)).toBe(stateOf('RELAY', state));
  });
});
