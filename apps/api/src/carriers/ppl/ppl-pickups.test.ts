import { describe, expect, it } from 'vitest';
import { CarrierRejectedError, type CarrierPickupRequest } from '../carrier.js';
import { orderBatchId, PPL_PICKUP_MAX_PARCELS, PplPickups } from './ppl-pickups.js';

const request = (over: Partial<CarrierPickupRequest> = {}): CarrierPickupRequest => ({
  clientReference: 'SV-000001-0a1b2c3d',
  pickupCode: 'SV-000001',
  date: '2026-11-17',
  window: null,
  parcelCount: 2,
  settings: {
    service: 'SIM-A',
    label: { format: 'PDF', dpi: 203, complete: false },
    sender: {
      name: 'AYVO Přerov',
      addressLine1: 'Průmyslová 1',
      addressLine2: null,
      postalCode: '750 02',
      city: 'Přerov',
      countryCode: 'CZ',
      contactName: 'Expedice',
      phone: '+420 581 000 333',
      email: 'expedice@ayvo.test',
    },
  },
  ...over,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof CarrierRejectedError ? e.code : String(e);
  }
  return null;
};

describe('PPL pickup order body (doc 029 §11)', () => {
  it('one CollectionOrder with the documented required fields, no recipient', () => {
    const body = PplPickups.body(request({ window: { from: '13:00', to: '16:00' } }));
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      orderType: 'CollectionOrder',
      referenceId: 'SV-000001-0a1b2c3d',
      customerReference: 'SV-000001',
      shipmentCount: 2,
      sendDate: '2026-11-17T00:00:00',
      note: 'SV-000001, okno 13:00-16:00',
      sender: { name: 'AYVO Prerov', street: 'Prumyslova 1', zipCode: '75002', country: 'CZ' },
    });
    expect(body.orders[0]).not.toHaveProperty('recipient');
    // The window's own fields have no documented format: never sent.
    expect(JSON.stringify(body)).not.toMatch(/sendTime/);
  });

  it('refused before anything is sent: no parcels, too many, no date, no sender, too long', () => {
    expect(code(() => PplPickups.body(request({ parcelCount: 0 })))).toBe('PPL_PICKUP_EMPTY');
    expect(PPL_PICKUP_MAX_PARCELS).toBe(50);
    expect(code(() => PplPickups.body(request({ parcelCount: 50 })))).toBeNull();
    expect(code(() => PplPickups.body(request({ parcelCount: 51 })))).toBe('PPL_PICKUP_TOO_LARGE');
    expect(code(() => PplPickups.body(request({ date: '17.11.2026' })))).toBe('PPL_PICKUP_DATE');
    const r = request();
    expect(code(() => PplPickups.body({ ...r, settings: { ...r.settings, sender: null } }))).toBe(
      'PPL_PICKUP_SENDER',
    );
    const long = request();
    long.settings.sender!.email = `${'x'.repeat(95)}@ayvo.test`;
    expect(code(() => PplPickups.body(long))).toBe('PPL_FIELD_TOO_LONG');
  });
});

describe('orderBatchId (Location of POST /order/batch)', () => {
  const id = '3f2b8a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  it('the UUID after /order/batch/, absolute or relative', () => {
    expect(orderBatchId(`https://api-dev.dhl.com/ecs/ppl/myapi2/order/batch/${id}`)).toBe(id);
    expect(orderBatchId(`/ecs/ppl/myapi2/order/batch/${id.toUpperCase()}/`)).toBe(id);
  });
  it('nothing else', () => {
    expect(orderBatchId(null)).toBeNull();
    expect(orderBatchId(`/ecs/ppl/myapi2/shipment/batch/${id}`)).toBeNull();
    expect(orderBatchId('/ecs/ppl/myapi2/order/batch/not-a-uuid')).toBeNull();
    expect(orderBatchId(`/order/batch/${id}/extra`)).toBeNull();
  });
});
