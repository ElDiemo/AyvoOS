import { describe, expect, it } from 'vitest';
import { CarrierRejectedError, type CarrierShipmentRequest } from '../src/carriers/carrier.js';
import { PplGateway } from '../src/carriers/ppl/ppl-gateway.js';

/**
 * What the PPL batch carries about weight and Germany (PPL support 2026-10-21, doc 029 §5): the
 * weight unit is kilograms and the weight optional, so the unit is no reason to refuse anything;
 * PPL's documentation still makes the weight mandatory for Germany (CPL R2502) and AYVO sends no
 * weight — Germany stays refused for that reason alone. A calculated reference is never sent as if
 * the parcel had been weighed. Pure: nothing is sent anywhere.
 */
const request = (
  countryCode: string,
  parcels: { weightG: string | null }[] = [{ weightG: '2595.000' }],
): CarrierShipmentRequest => ({
  clientReference: 'SHP-000001-1',
  orderCode: 'ORD-000001',
  settings: {
    service: 'SIM-A',
    label: { format: 'PDF', dpi: 203, complete: false },
    sender: {
      name: 'AYVO test',
      addressLine1: 'Prumyslova 1',
      addressLine2: null,
      postalCode: '75002',
      city: 'Prerov',
      countryCode: 'CZ',
      contactName: null,
      phone: null,
      email: null,
    },
  },
  recipient: {
    name: 'Hotel test',
    addressLine1: 'Hauptstrasse 1',
    addressLine2: null,
    postalCode: countryCode === 'DE' ? '10115' : '81102',
    city: countryCode === 'DE' ? 'Berlin' : 'Bratislava',
    countryCode,
    contactName: 'Rezeption',
    phone: '+421 000 000 000',
    email: 'recepce@hotel.test',
  },
  parcels: parcels.map((p, i) => ({
    parcelNo: i + 1,
    reference: `SHP-000001-1-${i + 1}`,
    crate: `AYV-C-00000${i + 1}`,
    weightG: p.weightG,
    dimensionsMm: null,
  })),
});

describe('PPL batch: weight and Germany (PPL support 2026-10-21)', () => {
  it('Germany is refused only because PPL documents the weight as mandatory there — not for its unit', () => {
    const error = (() => {
      try {
        PplGateway.batch(request('DE'));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(CarrierRejectedError);
    expect((error as CarrierRejectedError).code).toBe('PPL_COUNTRY_UNSUPPORTED');
    const message = (error as CarrierRejectedError).message;
    expect(message).toMatch(/Germany/);
    expect(message).toMatch(/R2502/);
    expect(message).not.toMatch(/unit|not confirmed/i);
  });

  it('elsewhere no weight is sent — neither a reference (Hotovo) value nor anything else', () => {
    for (const country of ['CZ', 'SK', 'AT']) {
      const single = PplGateway.batch(request(country));
      const set = PplGateway.batch(request(country, [{ weightG: '2595.000' }, { weightG: '1.5' }]));
      for (const body of [single, set]) {
        expect(JSON.stringify(body), country).not.toMatch(/weigh/i);
      }
    }
  });

  it('the adapter declares the weight as not used', () => {
    expect(new PplGateway(fakeClient(), 'test-account').rules.parcelWeight).toBe('NOT_USED');
  });
});

function fakeClient() {
  return {
    connection: { code: 'PPL_TEST', environment: 'TEST' },
  } as unknown as ConstructorParameters<typeof PplGateway>[0];
}
