import type { CarrierInfo, OrderShipment, Shipment } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { shipmentPhase } from './shipment-phase';

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
    createdAt: '2026-10-18T10:00:00.000Z',
    ...over,
  },
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
    expect(shipmentPhase('READY_TO_DISPATCH', { carrier, shipment: null, cancelled: [] })).toBe(
      'NO_SHIPMENT',
    );
    // An order completed before doc 029 at a site without a carrier: no button to be refused.
    expect(
      shipmentPhase('READY_TO_DISPATCH', { carrier: none, shipment: null, cancelled: [] }),
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
