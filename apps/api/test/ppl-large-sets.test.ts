import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarrierRejectedError, type CarrierShipmentRequest } from '../src/carriers/carrier.js';
import { PplClient } from '../src/carriers/ppl/ppl-client.js';
import { PPL_SET_MAX, PplGateway } from '../src/carriers/ppl/ppl-gateway.js';
import { FakePpl } from './support/fake-ppl.js';

/**
 * Large sets against the SIMULATED PPL API (PPL37-R2) — no real shipments. The simulator keeps the
 * documented contract of GET /shipment (at most 50 ShipmentNumbers, Limit/Offset paging with
 * X-Paging-Total-Items-Count) and of POST shipment/batch (at most 50 parcels per set).
 */
describe('PPL adapter: large sets, paging (simulated PPL)', () => {
  const ppl = new FakePpl('large-set-client', 'large-set-secret');
  let gateway: PplGateway;
  const signal = () => AbortSignal.timeout(30_000);

  beforeAll(async () => {
    await ppl.start();
    const client = new PplClient({
      code: 'PPL_TEST',
      environment: 'TEST',
      baseUrl: ppl.base,
      clientId: ppl.clientId,
      clientSecret: ppl.clientSecret,
    });
    gateway = new PplGateway(client, 'test-account');
  });
  afterAll(() => ppl.stop());
  beforeEach(() => ppl.reset());

  let serial = 0;
  const request = (parcels: number): CarrierShipmentRequest => {
    const clientReference = `SHP-9${String(++serial).padStart(5, '0')}-1`;
    return {
      clientReference,
      orderCode: 'ORD-900001',
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
        addressLine1: 'Namesti 1',
        addressLine2: null,
        postalCode: '75002',
        city: 'Prerov',
        countryCode: 'CZ',
        contactName: 'Recepce',
        phone: '+420 000 000 000',
        email: 'recepce@hotel.test',
      },
      parcels: Array.from({ length: parcels }, (_, i) => ({
        parcelNo: i + 1,
        reference: `${clientReference}-${i + 1}`,
        crate: `AYV-C-${String(i + 1).padStart(6, '0')}`,
        weightG: null,
        dimensionsMm: null,
      })),
    };
  };
  const shipmentQueries = () =>
    ppl.seen.filter((s) => s.method === 'GET' && s.path === '/shipment').length;

  /** Creates the set and follows it until PPL reports it complete; returns the outcome. */
  async function created(r: CarrierShipmentRequest) {
    const first = await gateway.create(r, signal());
    expect(first.kind).toBe('ACCEPTED');
    const carrierRef = (first as { carrierRef: string }).carrierRef;
    const outcome = await gateway.poll(
      { clientReference: r.clientReference, carrierRef, request: r },
      signal(),
    );
    expect(outcome.kind).toBe('CREATED');
    return outcome as Extract<typeof outcome, { kind: 'CREATED' }>;
  }

  it(`${PPL_SET_MAX} parcels (the documented maximum): all mapped and cancelled across pages`, async () => {
    // The server answers in pages of 20 although 50 are asked for — 3 pages per lookup.
    ppl.mode.pageCap = 20;
    const r = request(PPL_SET_MAX);
    const before = shipmentQueries();
    const outcome = await created(r);
    expect(outcome.numbers).toHaveLength(50);
    expect(shipmentQueries() - before).toBe(3);
    // Every parcel proven by its own reference — none left unverified on a later page.
    expect(outcome.parcels).toHaveLength(50);
    const byNumber = new Map(
      [...ppl.batches.values()].at(-1)!.numbers.map((n) => [n.number, n.ref]),
    );
    for (const p of outcome.parcels) {
      expect(byNumber.get(p.number)).toBe(`${r.clientReference}-${p.parcelNo}`);
    }
    // Cancellation reads every state (paged), cancels all 50 and confirms all 50.
    expect(await gateway.cancel({ parcels: outcome.numbers }, signal())).toBe('PENDING');
    for (const n of outcome.numbers) expect(ppl.cancelled.has(n)).toBe(true);
    expect(await gateway.cancelStatus({ parcels: outcome.numbers }, signal())).toBe('CANCELLED');
  });

  it('51 parcels: refused before anything is sent (no token, no batch)', async () => {
    const tokens = ppl.tokens;
    const batches = ppl.batches.size;
    const seen = ppl.seen.length;
    const error = await gateway.create(request(PPL_SET_MAX + 1), signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CarrierRejectedError);
    expect((error as CarrierRejectedError).code).toBe('PPL_SET_TOO_LARGE');
    expect(ppl.tokens).toBe(tokens);
    expect(ppl.batches.size).toBe(batches);
    expect(ppl.seen.length).toBe(seen);
  });

  it('more numbers than one request may carry: looked up in chunks of 50, never dropped', async () => {
    // Two complete sets (40 + 30 = 70 numbers), cancelled together: 2 chunks (50 + 20).
    ppl.mode.pageCap = 25;
    const a = await created(request(40));
    const b = await created(request(30));
    const numbers = [...a.numbers, ...b.numbers];
    const before = shipmentQueries();
    // Nothing cancelled yet, nothing picked up: still to be asked (all 70 states were read).
    expect(await gateway.cancelStatus({ parcels: numbers }, signal())).toBe('PENDING');
    // Chunk of 50 → pages of 25, 25; chunk of 20 → one page.
    expect(shipmentQueries() - before).toBe(3);
    const asked = ppl.seen
      .filter((s) => s.method === 'GET' && s.path === '/shipment')
      .slice(-3)
      .map((s) => s.query.getAll('ShipmentNumbers').length);
    expect(asked).toEqual([50, 50, 20]);
    expect(await gateway.cancel({ parcels: numbers }, signal())).toBe('PENDING');
    expect(numbers.every((n) => ppl.cancelled.has(n))).toBe(true);
    expect(await gateway.cancelStatus({ parcels: numbers }, signal())).toBe('CANCELLED');
  });

  it('a page that cannot be read means "unknown" — never a partial truth', async () => {
    ppl.mode.pageCap = 20;
    const r = request(45);
    const outcome = await created(r);
    ppl.mode.down = true;
    expect(await gateway.cancelStatus({ parcels: outcome.numbers }, signal())).toBe('UNKNOWN');
  });

  it('tracking (doc 031): each number answered by its own shipmentNumber, in Czech, across pages', async () => {
    ppl.mode.pageCap = 20;
    const outcome = await created(request(30));
    const [first, second, last] = [outcome.numbers[0]!, outcome.numbers[1]!, outcome.numbers[29]!];
    // Shaped as the PPL TEST environment answered on 2026-10-20 (statusId + textual code).
    ppl.mode.events[first] = [
      {
        statusId: 900,
        code: 'WaitingForShipment',
        phase: 'Order',
        group: 'WaitingForShipment',
        eventDate: '2026-10-21T08:00:00+02:00',
        name: 'Čekáme na přijetí zásilky do přepravy.',
      },
      {
        statusId: 150,
        code: 'PickedUp',
        phase: 'InTransport',
        group: 'PickedUp',
        eventDate: '2026-10-21T14:10:00+02:00',
        name: 'Zásilku jsme převzali od odesílatele.',
      },
    ];
    ppl.mode.events[last] = [
      {
        statusId: 450,
        code: 'Delivered',
        phase: 'Delivered',
        group: 'Delivered',
        eventDate: '2026-10-22T10:00:00+02:00',
        name: 'Zásilku jsme doručili příjemci.',
      },
      { statusId: 450, code: 'Delivered', eventDate: 'not a date' },
    ];
    // A number PPL does not know is reported as missing, never borrowed from another.
    const asked = [last, 'NOT-A-PPL-NUMBER', first, second];
    const t = await gateway.track({ parcels: asked }, signal());
    expect(t.parcels.map((p) => [p.number, p.found, p.events.map((e) => e.meaning)])).toEqual([
      [last, true, ['DELIVERED']],
      ['NOT-A-PPL-NUMBER', false, []],
      [first, true, ['DATA', 'PICKED_UP']],
      [second, true, []],
    ]);
    expect(t.parcels[0]!.dropped).toBe(1);
    expect(t.parcels[2]!.events[1]).toMatchObject({
      statusId: 150,
      code: 'PickedUp',
      phase: 'InTransport',
      occurredAt: new Date('2026-10-21T12:10:00Z'),
    });
    const lookups = ppl.seen.filter((s) => s.method === 'GET' && s.path === '/shipment').slice(-1);
    expect(lookups[0]!.lang).toBe('cs-CZ');
    // An outage: no answer at all (never a partial one).
    ppl.mode.down = true;
    await expect(gateway.track({ parcels: [first] }, signal())).rejects.toThrow();
  });
});
