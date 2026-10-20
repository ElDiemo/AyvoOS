import type { OrderShipment, PrintJobView, Shipment } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { combinedOutcome, printTargets } from './print-status';

const job = (status: PrintJobView['status'], printer: string): PrintJobView => ({
  code: 'PRJ-000001',
  status,
  kind: 'SHIPMENT',
  printer,
  createdAt: '2026-10-20T10:00:00.000Z',
  finishedAt: null,
  detail: null,
  requestedBy: 'Admin',
  reason: null,
});
const printer = (name: string) =>
  ({
    id: '01990000-0000-7000-8000-0000000000a1',
    code: name,
    name,
    model: 'Zebra ZD220 DT',
    dpi: 203,
    autoPrint: true,
    reportedState: 'READY',
    reportedAt: null,
    agent: { code: 'RPI', lastSeenAt: null, online: true },
  }) as OrderShipment['printer'];
const data = (over: Partial<Shipment>, next: string | null = 'Zebra B'): OrderShipment =>
  ({
    carrier: {} as never,
    printer: next ? printer(next) : null,
    cancelled: [],
    shipment: {
      code: 'SHP-000001',
      status: 'LABELED',
      parcels: [],
      request: { status: 'SUCCEEDED', errorMessage: null },
      zpl: { status: 'DONE', dpi: 203, attempts: 1, errorCode: null, errorMessage: null },
      printWaiting: [],
      ...over,
    },
  }) as unknown as OrderShipment;
const parcels = (...statuses: [PrintJobView['status'], string][]) =>
  statuses.map(([s, p], i) => ({ parcelNo: i + 1, printJobs: [job(s, p)] })) as never;

describe('printTargets (UI38-R1)', () => {
  it('work on its way keeps its printer; a new print goes to the current default', () => {
    // The default changed from A to B after the jobs were queued on A.
    const t = printTargets(data({ parcels: parcels(['QUEUED', 'Zebra A'], ['SENT', 'Zebra A']) }));
    expect(t.active).toEqual(['Zebra A']);
    expect(t.next?.name).toBe('Zebra B');
  });

  it('waiting requests count as work on its way; finished jobs do not', () => {
    const t = printTargets(
      data({
        parcels: parcels(['SENT', 'Zebra A'], ['CANCELLED', 'Zebra A']),
        printWaiting: [{ kind: 'SHIPMENT', printer: 'Zebra C', parcelNo: null, requestedAt: '' }],
      }),
    );
    expect(t.active).toEqual(['Zebra C']);
  });
});

describe('combinedOutcome: an HTTP 200 is not success by itself', () => {
  it('a carrier refusal is shown as such, with its reason', () => {
    const o = combinedOutcome(
      data({
        status: 'DRAFT',
        request: { status: 'REJECTED', errorMessage: 'Neplatné PSČ' } as never,
      }),
      'Zebra B',
    );
    expect(o.tone).toBe('error');
    expect(o.text).toContain('nevytvořil: Neplatné PSČ');
  });

  it('labels still being created: informs, never claims printing', () => {
    const o = combinedOutcome(
      data({ status: 'REQUESTING', request: { status: 'ACCEPTED' } as never }),
      'Zebra B',
    );
    expect(o.tone).toBe('info');
    expect(o.text).toContain('ještě připravuje');
  });

  it('labels made but no ZPL: an error, nothing printed', () => {
    const o = combinedOutcome(
      data({
        zpl: {
          status: 'FAILED',
          dpi: 203,
          attempts: 3,
          errorCode: 'X',
          errorMessage: 'pozice 3/3',
        },
      }),
      'Zebra B',
    );
    expect([o.tone, o.text.includes('nic se netiskne')]).toEqual(['error', true]);
  });

  it('labels made and queued: says how many go to which printer', () => {
    const o = combinedOutcome(
      data({ parcels: parcels(['QUEUED', 'Zebra B'], ['QUEUED', 'Zebra B']) }),
      'Zebra B',
    );
    expect(o).toEqual({
      tone: 'ok',
      text: expect.stringContaining('2 z 2 jde do tiskárny Zebra B'),
    });
  });

  it('without printing: labels ready, printing on the order', () => {
    expect(combinedOutcome(data({}), null).tone).toBe('ok');
  });
});
