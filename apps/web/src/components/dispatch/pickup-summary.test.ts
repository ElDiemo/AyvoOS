import type { PickupBoard, PickupView } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { boardAutoChecking, pickupSummary } from './pickup-summary';

type Cancellation = NonNullable<PickupView['cancellation']>;

const pickup = (over: Partial<PickupView> = {}): PickupView => ({
  code: 'SV-000001',
  status: 'CONFIRMED',
  date: '2026-11-23',
  window: null,
  parcelCount: 1,
  carrier: { code: 'PPL', environment: 'TEST' },
  reference: 'SV-000001-0a1b2c3d',
  carrierOrderNumber: '0226112110000',
  carrierState: 'Created',
  cancelledByCarrierAt: null,
  dayPassed: false,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-11-21T13:06:21.000Z',
  sentAt: '2026-11-21T13:06:21.000Z',
  resolvedAt: '2026-11-21T13:06:41.000Z',
  resolutionReason: null,
  lookupFrom: null,
  cancellation: null,
  parcels: [],
  ...over,
});
const cancellation = (over: Partial<Cancellation> = {}): Cancellation => ({
  id: '01a1fe38-7124-776e-af0d-4d4e119642f6',
  status: 'SENT',
  reason: 'Termín se posunul',
  createdAt: '2026-11-21T13:07:54.000Z',
  sentAt: '2026-11-21T13:07:54.000Z',
  resolvedAt: null,
  carrierState: null,
  errorCode: 'NO_ANSWER',
  errorMessage: 'No usable answer from the carrier: HTTP 502',
  lookupFrom: null,
  lookingUp: true,
  lookups: 0,
  lookupsExhausted: false,
  nextLookupAt: '2026-11-21T13:08:04.000Z',
  resolutionReason: null,
  ...over,
});

describe('pickupSummary — the first layer of a pickup (AYVO UX rule)', () => {
  it('confirmed: says so with its day; the one action is Zrušit svoz', () => {
    expect(pickupSummary(pickup())).toEqual({
      tone: 'ok',
      title: 'Svoz potvrzen',
      hint: 'Svoz je objednaný na 23. 11. 2026.',
      action: 'cancel',
    });
    // After its day no cancellation starts.
    expect(pickupSummary(pickup({ dayPassed: true })).action).toBeNull();
  });

  it('an uncertain cancellation: parcels held, looked up automatically — never "lost"', () => {
    const s = pickupSummary(pickup({ cancellation: cancellation() }));
    expect(s).toMatchObject({
      tone: 'wait',
      title: 'Čekáme na potvrzení storna. Balíky zatím nelze přeplánovat.',
      hint: 'Stav storna u PPL ověřujeme automaticky.',
      action: 'lookup',
    });
    expect(JSON.stringify(s)).not.toMatch(/ztratil/);
  });

  it('lookups ran out: a clear hand-over to an administrator, still held, no second cancellation', () => {
    const s = pickupSummary(
      pickup({
        cancellation: cancellation({ lookingUp: false, lookupsExhausted: true, lookups: 30 }),
      }),
    );
    expect(s.tone).toBe('warn');
    expect(s.title).toBe('Čekáme na potvrzení storna. Balíky zatím nelze přeplánovat.');
    expect(s.hint).toMatch(/automatické ověřování skončilo\. Předejte to správci/);
    expect(s.action).toBe('lookup');
  });

  it('only the carrier’s Canceled releases the parcels', () => {
    const shown = pickupSummary(
      pickup({
        cancelledByCarrierAt: '2026-11-21T14:00:00.000Z',
        cancellation: cancellation({ status: 'CONFIRMED', carrierState: 'Canceled' }),
      }),
    );
    expect(shown).toEqual({
      tone: 'done',
      title: 'Svoz zrušen',
      hint: 'Balíky lze zařadit do jiného svozu.',
      action: null,
    });
    // "Created" read by a lookup is still waiting.
    const created = pickupSummary(
      pickup({ cancellation: cancellation({ carrierState: 'Created', lookups: 3 }) }),
    );
    expect(created.title).toBe('Čekáme na potvrzení storna. Balíky zatím nelze přeplánovat.');
  });

  it('a refusal with a clear next step gives it in Czech; any other reason points to Podrobnosti', () => {
    const auth = pickupSummary(
      pickup({ cancellation: cancellation({ status: 'REJECTED', errorCode: 'PPL_AUTH' }) }),
    );
    expect(auth.title).toBe('Svoz potvrzen');
    expect(auth.hint).toBe(
      'PPL storno odmítlo – svoz dál platí. PPL odmítlo přihlášení serveru, nic se neodeslalo. Předejte to správci dopravců.',
    );
    expect(auth.action).toBe('cancel');
    const rejected = pickupSummary(
      pickup({ status: 'REJECTED', errorCode: 'PPL_SOMETHING', carrierOrderNumber: null }),
    );
    expect(rejected).toMatchObject({ tone: 'warn', title: 'PPL svoz odmítlo', action: null });
    expect(rejected.hint).toBe('Důvod je v podrobnostech. Balíky lze zařadit do nového svozu.');
  });

  it('an uncertain pickup order and one waiting for PPL', () => {
    expect(pickupSummary(pickup({ status: 'SENT', carrierOrderNumber: null }))).toMatchObject({
      title: 'Čekáme na PPL',
      action: 'lookup',
    });
    expect(pickupSummary(pickup({ status: 'SENT' })).hint).toMatch(/zatím nepotvrdilo/);
    expect(pickupSummary(pickup({ status: 'PREPARED' })).action).toBeNull();
    expect(pickupSummary(pickup({ status: 'NOT_SENT', errorCode: 'PICKUP_DAY_PASSED' })).hint).toBe(
      'Den svozu minul dřív, než se požadavek odeslal. Objednejte nový svoz.',
    );
  });
});

describe('boardAutoChecking — the board refreshes itself only while the server settles something', () => {
  const board = (pickups: PickupView[]) =>
    ({
      today: '2026-11-21',
      carrier: {},
      candidates: [],
      open: null,
      pickups,
    }) as unknown as PickupBoard;

  it('while a cancellation is looked up automatically, or a pickup is written or accepted', () => {
    expect(boardAutoChecking(board([pickup({ cancellation: cancellation() })]))).toBe(true);
    expect(boardAutoChecking(board([pickup({ status: 'ACCEPTED' })]))).toBe(true);
    expect(boardAutoChecking(board([pickup({ status: 'PREPARED' })]))).toBe(true);
    expect(
      boardAutoChecking(
        board([pickup({ cancellation: cancellation({ status: 'PREPARED', lookingUp: false }) })]),
      ),
    ).toBe(true);
  });

  it('stops when the lookups ran out, when PPL confirmed, and for a person-only uncertain pickup', () => {
    const exhausted = cancellation({ lookingUp: false, lookupsExhausted: true, lookups: 30 });
    expect(boardAutoChecking(board([pickup({ cancellation: exhausted })]))).toBe(false);
    const confirmed = cancellation({ status: 'CONFIRMED', lookingUp: false });
    expect(
      boardAutoChecking(
        board([
          pickup({ cancelledByCarrierAt: '2026-11-21T14:00:00.000Z', cancellation: confirmed }),
        ]),
      ),
    ).toBe(false);
    expect(boardAutoChecking(board([pickup(), pickup({ status: 'SENT' })]))).toBe(false);
    expect(boardAutoChecking(board([]))).toBe(false);
  });
});
