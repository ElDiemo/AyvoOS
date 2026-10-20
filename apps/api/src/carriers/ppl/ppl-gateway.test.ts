import { describe, expect, it } from 'vitest';
import { batchId, latin } from './ppl-gateway.js';

describe('PPL gateway helpers', () => {
  it('reads the batch id from an absolute or relative Location, whatever its format', () => {
    const uuid = '3f0c1b8e-5d2a-4c7b-9a61-0e2f4d8c7b10';
    expect(batchId(`https://api-dev.dhl.com/ecs/ppl/myapi2/shipment/batch/${uuid}`)).toBe(uuid);
    expect(batchId(`/ecs/ppl/myapi2/shipment/batch/${uuid}/`)).toBe(uuid);
    expect(batchId('/shipment/batch/B-2026_00042')).toBe('B-2026_00042');
    for (const bad of [null, '', '/shipment/batch/', '/shipment/123', '/shipment/batch/a b', '::'])
      expect(batchId(bad), String(bad)).toBeNull();
  });

  it('turns Czech, Polish, German text and typographic marks into Latin', () => {
    expect(latin('Přerov – Průmyslová „1“')).toBe('Prerov - Prumyslova "1"');
    expect(latin('Łódź, Straße, Đakovo')).toBe('Lodz, Strasse, Dakovo');
  });
});
