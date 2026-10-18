import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  CarrierRejectedError,
  type CarrierCreateOutcome,
  type CarrierGateway,
  type CarrierPollOutcome,
  type CarrierRules,
  type CarrierShipmentRequest,
} from './carrier.js';

/**
 * A FAKE carrier for automated tests only (CARRIER_PROVIDER=test, which the environment allows
 * only with APP_ENV=test — never on DEV or production). Its labels say so on every page. Tests
 * steer it through {@link testCarrierControl}; by default every request succeeds.
 */
type Behaviour =
  /** Creates and answers. */
  | 'SUCCEED'
  /** Refuses (nothing created). */
  | 'REJECT'
  /** Accepts for asynchronous processing; created on the next poll. */
  | 'ACCEPT'
  /** Fails before anything is created (the answer is lost on the way there). */
  | 'LOSE_BEFORE'
  /** Creates, then the answer is lost. */
  | 'LOSE_AFTER'
  /** Creates, but the label download fails once. */
  | 'LABELS_FAIL_ONCE';

interface Created {
  shipmentRef: string;
  parcels: { parcelNo: number; number: string }[];
  request: CarrierShipmentRequest;
  cancelled: boolean;
}

export const testCarrierControl = {
  next: [] as Behaviour[],
  rules: {
    parcelWeight: 'REQUIRED',
    parcelDimensions: 'OPTIONAL',
    senderAddress: 'OPTIONAL',
    canCancel: true,
  } as CarrierRules,
  /** Every create() call, in order — tests assert that nothing is sent twice. */
  calls: [] as CarrierShipmentRequest[],
  created: new Map<string, Created>(),
  accepted: new Map<string, CarrierShipmentRequest>(),
  labelsFail: new Set<string>(),
  reset(): void {
    this.next = [];
    this.calls = [];
    this.created.clear();
    this.accepted.clear();
    this.labelsFail.clear();
    this.rules = {
      parcelWeight: 'REQUIRED',
      parcelDimensions: 'OPTIONAL',
      senderAddress: 'OPTIONAL',
      canCancel: true,
    };
  },
};

let serial = 0;
function create(request: CarrierShipmentRequest): Created {
  serial += 1;
  const base = `TEST${String(Date.now()).slice(-6)}${String(serial).padStart(4, '0')}`;
  const created: Created = {
    shipmentRef: base,
    parcels: request.parcels.map((p) => ({
      parcelNo: p.parcelNo,
      number: `${base}-${p.parcelNo}`,
    })),
    request,
    cancelled: false,
  };
  testCarrierControl.created.set(request.clientReference, created);
  return created;
}

export class TestCarrier implements CarrierGateway {
  readonly code = 'TEST';
  readonly name = 'Testovací dopravce (jen automatické testy)';
  get rules(): CarrierRules {
    return testCarrierControl.rules;
  }

  async create(request: CarrierShipmentRequest): Promise<CarrierCreateOutcome> {
    testCarrierControl.calls.push(request);
    const behaviour = testCarrierControl.next.shift() ?? 'SUCCEED';
    if (behaviour === 'REJECT')
      throw new CarrierRejectedError('TEST_REJECTED', 'Refused by the test carrier');
    if (behaviour === 'LOSE_BEFORE')
      throw new Error('test carrier: connection lost before the request arrived');
    if (behaviour === 'ACCEPT') {
      const ref = `BATCH-${request.clientReference}`;
      testCarrierControl.accepted.set(ref, request);
      return { kind: 'ACCEPTED', carrierRef: ref };
    }
    const created = create(request);
    if (behaviour === 'LOSE_AFTER') throw new Error('test carrier: the answer was lost');
    if (behaviour === 'LABELS_FAIL_ONCE') testCarrierControl.labelsFail.add(created.shipmentRef);
    return { kind: 'CREATED', shipmentRef: created.shipmentRef, parcels: created.parcels };
  }

  async poll(query: {
    clientReference: string;
    carrierRef: string | null;
  }): Promise<CarrierPollOutcome> {
    const found = testCarrierControl.created.get(query.clientReference);
    if (found) return { kind: 'CREATED', shipmentRef: found.shipmentRef, parcels: found.parcels };
    const accepted = query.carrierRef
      ? testCarrierControl.accepted.get(query.carrierRef)
      : undefined;
    if (accepted) {
      testCarrierControl.accepted.delete(query.carrierRef!);
      const created = create(accepted);
      return { kind: 'CREATED', shipmentRef: created.shipmentRef, parcels: created.parcels };
    }
    return { kind: 'NOT_CREATED' };
  }

  async labels(query: { shipmentRef: string }): Promise<Uint8Array> {
    if (testCarrierControl.labelsFail.delete(query.shipmentRef)) {
      throw new Error('test carrier: label download failed');
    }
    const found = [...testCarrierControl.created.values()].find(
      (c) => c.shipmentRef === query.shipmentRef,
    );
    if (!found) throw new Error('test carrier: unknown shipment');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const p of found.parcels) {
      const page = pdf.addPage([283, 425]); // 100 × 150 mm
      const line = (text: string, y: number, size = 12) =>
        page.drawText(text, { x: 14, y, size, font, color: rgb(0, 0, 0) });
      line('TEST CARRIER - NOT A REAL LABEL', 395, 13);
      line(`Parcel ${p.parcelNo}/${found.parcels.length}`, 360);
      line(p.number, 335);
      line(
        `Ref: ${found.request.parcels.find((x) => x.parcelNo === p.parcelNo)?.reference ?? ''}`,
        310,
      );
      line(found.request.orderCode, 285);
    }
    return pdf.save();
  }

  async cancel(query: { shipmentRef: string }): Promise<void> {
    const found = [...testCarrierControl.created.values()].find(
      (c) => c.shipmentRef === query.shipmentRef,
    );
    if (!found) throw new CarrierRejectedError('TEST_UNKNOWN', 'Unknown shipment');
    found.cancelled = true;
  }
}
