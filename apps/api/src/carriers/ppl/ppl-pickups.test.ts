import { describe, expect, it } from 'vitest';
import type { PplClient } from './ppl-client.js';
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

describe('PPL pickup cancellation (POST /order/cancel) and lookup', () => {
  const client = (answers: { status: number; body?: unknown }[]) => {
    const calls: { method: string; path: string; query?: unknown; json?: unknown }[] = [];
    const fake = {
      accessToken: async () => 'token',
      request: async (method: string, path: string, opts: { query?: unknown; json?: unknown }) => {
        calls.push({ method, path, query: opts.query, json: opts.json });
        const a = answers.shift()!;
        return { status: a.status, headers: new Headers(), body: a.body ?? null };
      },
    };
    return { calls, pickups: new PplPickups(fake as unknown as PplClient) };
  };
  const signal = new AbortController().signal;

  it('one POST by the original reference; 200 = accepted only, confirmed by the state Canceled', async () => {
    const c = client([
      { status: 200, body: {} },
      { status: 200, body: [{ referenceId: 'R-1', orderNumber: '7', orderState: 'Canceled' }] },
    ]);
    expect(await c.pickups.cancel({ clientReference: 'R-1' }, signal)).toBe('ACCEPTED');
    expect(c.calls[0]).toMatchObject({
      method: 'POST',
      path: '/order/cancel',
      query: { orderReference: 'R-1' },
    });
    expect(await c.pickups.find({ clientReference: 'R-1' }, signal)).toEqual({
      orderNumber: '7',
      state: 'Canceled',
      cancelled: true,
    });
  });

  it('400 refuses; anything else is unknown; another reference is never matched', async () => {
    const refused = client([{ status: 400, body: { title: 'cannot' } }]);
    await expect(refused.pickups.cancel({ clientReference: 'R-1' }, signal)).rejects.toBeInstanceOf(
      CarrierRejectedError,
    );
    const unknown = client([{ status: 503 }]);
    await expect(
      unknown.pickups.cancel({ clientReference: 'R-1' }, signal),
    ).rejects.not.toBeInstanceOf(CarrierRejectedError);
    const other = client([{ status: 200, body: [{ referenceId: 'R-2', orderState: 'Canceled' }] }]);
    expect(await other.pickups.find({ clientReference: 'R-1' }, signal)).toBeNull();
    const created = client([
      { status: 200, body: [{ referenceId: 'R-1', orderState: 'Created' }] },
    ]);
    expect((await created.pickups.find({ clientReference: 'R-1' }, signal))!.cancelled).toBe(false);
  });
});
