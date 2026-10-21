import type { CarrierInfo, OrderShipment, Shipment } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { labelLinks, shipmentPhase } from './shipment-phase';

const carrier: CarrierInfo = {
  configured: true,
  unavailable: null,
  code: 'TEST',
  name: 'Test',
  environment: 'TEST',
  parcelWeight: 'REQUIRED',
  parcelDimensions: 'OPTIONAL',
  canCancel: true,
};
const none: CarrierInfo = { ...carrier, configured: false, unavailable: 'NOT_CONFIGURED' };
const shipment = (over: Partial<Shipment> = {}, site: CarrierInfo = carrier): OrderShipment => ({
  carrier: site,
  shipment: {
    code: 'SHP-000001',
    status: 'DRAFT',
    carrier,
    carrierShipmentRef: null,
    labeledAt: null,
    parcels: [],
    missing: [],
    request: null,
    cancelRequest: null,
    label: null,
    pollingStopped: false,
    zpl: null,
    printWaiting: [],
    createdAt: '2026-10-18T10:00:00.000Z',
    ...over,
  },
  printer: null,
  cancelled: [],
});
const request = (status: string, errorCode: string | null = null) =>
  ({
    attemptNo: 1,
    status,
    clientReference: 'SHP-000001-1',
    sentAt: null,
    errorCode,
    errorMessage: null,
    resolvableAt: null,
  }) as Shipment['request'];

describe('shipmentPhase (doc 029): one next step from the order status and its shipment', () => {
  it('follows the order status first; nothing before completion or after cancellation', () => {
    expect(shipmentPhase('OPEN', shipment())).toBeNull();
    expect(shipmentPhase('CANCELLED', shipment())).toBeNull();
    expect(shipmentPhase('READY_FOR_PICKUP', shipment({ status: 'LABELED' }))).toBe(
      'READY_FOR_PICKUP',
    );
    expect(shipmentPhase('HANDED_TO_CARRIER', shipment({ status: 'LABELED' }))).toBe('HANDED_OVER');
  });

  it('never offers labels without a carrier or with missing required data', () => {
    expect(
      shipmentPhase('READY_TO_DISPATCH', { carrier, shipment: null, printer: null, cancelled: [] }),
    ).toBe('NO_SHIPMENT');
    // An order completed before doc 029 at a site without a carrier: no button to be refused.
    expect(
      shipmentPhase('READY_TO_DISPATCH', {
        carrier: none,
        shipment: null,
        printer: null,
        cancelled: [],
      }),
    ).toBe('NO_CARRIER');
    expect(shipmentPhase('READY_TO_DISPATCH', shipment({ carrier: none }, none))).toBe(
      'NO_CARRIER',
    );
    expect(
      shipmentPhase(
        'READY_TO_DISPATCH',
        shipment({ missing: [{ field: 'PARCEL_WEIGHT', parcelNo: 2 }] }),
      ),
    ).toBe('MISSING');
    expect(shipmentPhase('READY_TO_DISPATCH', shipment())).toBe('CREATE');
  });

  it('an unresolved request is resolved, never created again; a cancellation is followed', () => {
    const at = (r: Shipment['request']) =>
      shipmentPhase('READY_TO_DISPATCH', shipment({ status: 'REQUESTING', request: r }));
    expect(at(request('SENT', 'NO_ANSWER'))).toBe('UNCERTAIN');
    expect(at(request('SENT'))).toBe('IN_FLIGHT');
    expect(at(request('PREPARED'))).toBe('PREPARED');
    expect(at(request('ACCEPTED'))).toBe('ACCEPTED');
    expect(at(request('CREATED'))).toBe('CREATED');
    expect(shipmentPhase('READY_TO_DISPATCH', shipment({ status: 'LABELED' }))).toBe('LABELED');
    expect(shipmentPhase('READY_TO_DISPATCH', shipment({ status: 'CANCELLING' }))).toBe(
      'CANCELLING',
    );
  });
});

describe('labelLinks (UI36-R1): only files that exist', () => {
  const parcel = (parcelNo: number, format: 'PDF' | 'ZPL' | null) =>
    ({ parcelNo, label: format ? { format, dpi: format === 'ZPL' ? 203 : null } : null }) as never;
  const labeled = (formats: ('PDF' | 'ZPL' | null)[], complete: boolean) =>
    shipment({
      status: 'LABELED',
      parcels: formats.map((f, i) => parcel(i + 1, f)),
      label: complete ? { format: 'PDF', dpi: null, createdAt: '2026-10-18T10:00:00.000Z' } : null,
    }).shipment;

  it('single PDF labels: each parcel, no complete document', () => {
    expect(labelLinks('ORD-000001', labeled(['PDF', 'PDF'], false))).toEqual([
      {
        href: '/api/admin/orders/ORD-000001/shipment/parcels/1/label',
        kind: 'PARCEL',
        parcelNo: 1,
        format: 'PDF',
      },
      {
        href: '/api/admin/orders/ORD-000001/shipment/parcels/2/label',
        kind: 'PARCEL',
        parcelNo: 2,
        format: 'PDF',
      },
    ]);
  });

  it('single ZPL labels: each parcel as ZPL, no complete document', () => {
    const links = labelLinks('ORD-000001', labeled(['ZPL', 'ZPL', 'ZPL'], false));
    expect(links.map((l) => [l.kind, l.format])).toEqual([
      ['PARCEL', 'ZPL'],
      ['PARCEL', 'ZPL'],
      ['PARCEL', 'ZPL'],
    ]);
  });

  it('A4: each parcel and the complete document', () => {
    const links = labelLinks('ORD-000001', labeled(['PDF', 'PDF', 'PDF'], true));
    expect(links.at(-1)).toEqual({
      href: '/api/admin/orders/ORD-000001/shipment/labels',
      kind: 'COMPLETE',
      parcelNo: null,
      format: 'PDF',
    });
    expect(links.filter((l) => l.kind === 'PARCEL')).toHaveLength(3);
  });

  it('nothing stored yet: no links', () => {
    expect(labelLinks('ORD-000001', labeled([null, null], false))).toEqual([]);
    expect(labelLinks('ORD-000001', null)).toEqual([]);
  });
});
