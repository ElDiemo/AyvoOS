import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  CarrierRejectedError,
  type CarrierCancelStatus,
  type CarrierCreateOutcome,
  type CarrierGateway,
  type CarrierParcelNumber,
  type CarrierPollOutcome,
  type CarrierRules,
  type CarrierSettingsSnapshot,
  type CarrierShipmentRequest,
} from './carrier.js';

/**
 * A FAKE carrier for automated tests only (CARRIER_PROVIDER=test, which the environment allows
 * only with APP_ENV=test — never on DEV or production). Its labels say so on every page. Tests
 * steer it through {@link testCarrierControl}; by default every request succeeds.
 */
type Behaviour =
  | 'SUCCEED'
  /** Refuses (nothing created). */
  | 'REJECT'
  /** Accepts for asynchronous processing; created on a later poll. */
  | 'ACCEPT'
  /** Accepts; the carrier's processing then fails (nothing created). */
  | 'ACCEPT_THEN_FAIL'
  /** Fails before anything is created (the answer is lost on the way there). */
  | 'LOSE_BEFORE'
  /** Creates, then the answer is lost. */
  | 'LOSE_AFTER'
  /** Never answers (until the caller's time limit aborts it). */
  | 'HANG'
  /** Creates, but the label download fails once. */
  | 'LABELS_FAIL_ONCE'
  /** Creates, but proves the number of only some parcels (once; a lookup proves all). */
  | 'MISMATCH_ONCE'
  /** Creates only some parcels of a set (the others fail). */
  | 'PARTIAL';

interface Created {
  shipmentRef: string;
  parcels: CarrierParcelNumber[];
  request: CarrierShipmentRequest;
  cancelled: boolean;
}

const defaultRules = (): CarrierRules => ({
  parcelWeight: 'REQUIRED',
  parcelDimensions: 'OPTIONAL',
  senderAddress: 'OPTIONAL',
  canCancel: true,
});

export const testCarrierControl = {
  next: [] as Behaviour[],
  rules: defaultRules(),
  /** How the next cancellations answer. */
  cancel: [] as ('CONFIRM' | 'PENDING' | 'REFUSE' | 'LOSE')[],
  /** What the next cancellation status checks answer (else from the fake state). */
  cancelStatus: [] as CarrierCancelStatus[],
  /** Polls still answering "pending" before an accepted request is processed. */
  pendingPolls: 0,
  /** Every create() call, in order — tests assert that nothing is sent twice. */
  calls: [] as CarrierShipmentRequest[],
  polls: 0,
  cancelCalls: 0,
  created: new Map<string, Created>(),
  mismatch: new Set<string>(),
  partial: new Set<string>(),
  accepted: new Map<string, { request: CarrierShipmentRequest; fail: boolean }>(),
  labelsFail: new Set<string>(),
  reset(): void {
    this.next = [];
    this.cancel = [];
    this.cancelStatus = [];
    this.pendingPolls = 0;
    this.calls = [];
    this.polls = 0;
    this.cancelCalls = 0;
    this.created.clear();
    this.accepted.clear();
    this.labelsFail.clear();
    this.mismatch.clear();
    this.partial.clear();
    this.rules = defaultRules();
  },
};

/** The settings every site uses with the test carrier (it has no site configuration). */
export const TEST_CARRIER_SETTINGS: CarrierSettingsSnapshot = {
  service: 'TEST',
  label: { format: 'PDF', dpi: 203, complete: true },
  sender: null,
};

let serial = 0;
function create(request: CarrierShipmentRequest): Created {
  serial += 1;
  const base = `TEST${String(Date.now()).slice(-6)}${String(serial).padStart(4, '0')}`;
  // Answered in REVERSE parcel order on purpose: callers must map by the parcel's own reference.
  const parcels = request.parcels
    .map((p) => ({ parcelNo: p.parcelNo, number: `${base}${String(p.parcelNo).padStart(2, '0')}` }))
    .reverse();
  const created: Created = { shipmentRef: base, parcels, request, cancelled: false };
  testCarrierControl.created.set(request.clientReference, created);
  return created;
}

const abortable = <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('test carrier: timed out')), {
      once: true,
    });
    work().then(resolve, reject);
  });

async function labelPdf(created: Created, only: number | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const all = [...created.parcels].sort((a, b) => a.parcelNo - b.parcelNo);
  for (const p of all.filter((x) => only === null || x.parcelNo === only)) {
    const page = pdf.addPage([283, 425]); // 100 × 150 mm
    const line = (text: string, y: number, size = 12) =>
      page.drawText(text, { x: 14, y, size, font, color: rgb(0, 0, 0) });
    const sent = created.request.parcels.find((x) => x.parcelNo === p.parcelNo)!;
    line('TEST CARRIER - NOT A REAL LABEL', 395, 13);
    line(`Parcel ${p.parcelNo}/${all.length}`, 360);
    line(p.number, 335);
    line(`Crate: ${sent.crate}`, 310);
    line(created.request.orderCode, 285);
  }
  return pdf.save();
}

function createdOutcome(c: Created): CarrierCreateOutcome {
  const numbers = c.parcels.map((p) => p.number);
  if (testCarrierControl.partial.has(c.shipmentRef)) {
    return {
      kind: 'CREATED',
      shipmentRef: c.shipmentRef,
      numbers: numbers.slice(0, 1),
      parcels: [],
      problem: { code: 'CARRIER_PARTIAL', message: 'Only some parcels were created' },
    };
  }
  if (testCarrierControl.mismatch.delete(c.shipmentRef)) {
    return { kind: 'CREATED', shipmentRef: c.shipmentRef, numbers, parcels: c.parcels.slice(1) };
  }
  return { kind: 'CREATED', shipmentRef: c.shipmentRef, numbers, parcels: c.parcels };
}

const byRef = (shipmentRef: string) =>
  [...testCarrierControl.created.values()].find((c) => c.shipmentRef === shipmentRef);

export class TestCarrier implements CarrierGateway {
  readonly code = 'TEST';
  readonly name = 'Testovací dopravce (jen automatické testy)';
  readonly connection = 'TEST';
  readonly environment = 'TEST' as const;
  get rules(): CarrierRules {
    return testCarrierControl.rules;
  }

  create(request: CarrierShipmentRequest, signal: AbortSignal): Promise<CarrierCreateOutcome> {
    testCarrierControl.calls.push(request);
    const behaviour = testCarrierControl.next.shift() ?? 'SUCCEED';
    if (behaviour === 'HANG') return abortable(signal, () => new Promise<never>(() => undefined));
    return abortable(signal, async () => {
      if (behaviour === 'REJECT') {
        throw new CarrierRejectedError('TEST_REJECTED', 'Refused by the test carrier');
      }
      if (behaviour === 'LOSE_BEFORE') throw new Error('test carrier: connection lost');
      if (behaviour === 'ACCEPT' || behaviour === 'ACCEPT_THEN_FAIL') {
        const ref = `BATCH-${request.clientReference}`;
        testCarrierControl.accepted.set(ref, { request, fail: behaviour === 'ACCEPT_THEN_FAIL' });
        return { kind: 'ACCEPTED', carrierRef: ref };
      }
      const created = create(request);
      if (behaviour === 'LOSE_AFTER') throw new Error('test carrier: the answer was lost');
      if (behaviour === 'LABELS_FAIL_ONCE') testCarrierControl.labelsFail.add(created.shipmentRef);
      if (behaviour === 'MISMATCH_ONCE') testCarrierControl.mismatch.add(created.shipmentRef);
      if (behaviour === 'PARTIAL') testCarrierControl.partial.add(created.shipmentRef);
      return createdOutcome(created);
    });
  }

  poll(
    query: { clientReference: string; carrierRef: string | null },
    signal: AbortSignal,
  ): Promise<CarrierPollOutcome> {
    return abortable(signal, async () => {
      testCarrierControl.polls += 1;
      const found = testCarrierControl.created.get(query.clientReference);
      if (found) return createdOutcome(found);
      const accepted = query.carrierRef
        ? testCarrierControl.accepted.get(query.carrierRef)
        : undefined;
      if (accepted) {
        if (testCarrierControl.pendingPolls > 0) {
          testCarrierControl.pendingPolls -= 1;
          return { kind: 'PENDING' };
        }
        testCarrierControl.accepted.delete(query.carrierRef!);
        if (accepted.fail) {
          return { kind: 'REJECTED', code: 'TEST_BATCH_ERROR', message: 'Batch failed' };
        }
        return createdOutcome(create(accepted.request));
      }
      return { kind: 'NOT_CREATED' };
    });
  }

  labels(query: { shipmentRef: string; parcels: CarrierParcelNumber[] }, signal: AbortSignal) {
    return abortable(signal, async () => {
      if (testCarrierControl.labelsFail.delete(query.shipmentRef)) {
        throw new Error('test carrier: label download failed');
      }
      const found = byRef(query.shipmentRef);
      if (!found) throw new Error('test carrier: unknown shipment');
      return {
        parcels: await Promise.all(
          query.parcels.map(async (p) => ({
            parcelNo: p.parcelNo,
            format: 'PDF' as const,
            dpi: 203,
            bytes: await labelPdf(found, p.parcelNo),
          })),
        ),
        complete: { format: 'PDF' as const, dpi: 203, bytes: await labelPdf(found, null) },
      };
    });
  }

  cancel(query: { shipmentRef: string }, signal: AbortSignal): Promise<'CANCELLED' | 'PENDING'> {
    return abortable(signal, async () => {
      testCarrierControl.cancelCalls += 1;
      const found = byRef(query.shipmentRef);
      if (!found) throw new CarrierRejectedError('TEST_UNKNOWN', 'Unknown shipment');
      const mode = testCarrierControl.cancel.shift() ?? 'CONFIRM';
      if (mode === 'REFUSE') throw new CarrierRejectedError('TEST_TOO_LATE', 'Already picked up');
      if (mode === 'LOSE') {
        found.cancelled = true;
        throw new Error('test carrier: cancellation answer lost');
      }
      found.cancelled = true;
      return mode === 'PENDING' ? 'PENDING' : 'CANCELLED';
    });
  }

  cancelStatus(query: { shipmentRef: string }, signal: AbortSignal): Promise<CarrierCancelStatus> {
    return abortable(signal, async () => {
      const set = testCarrierControl.cancelStatus.shift();
      if (set) return set;
      return byRef(query.shipmentRef)?.cancelled ? 'CANCELLED' : 'NOT_CANCELLED';
    });
  }
}
