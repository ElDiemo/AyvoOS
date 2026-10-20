import { describe, expect, it } from 'vitest';
import { pplEvents, pplMeaning } from './ppl-tracking.js';

/**
 * The meaning of PPL tracking codes (doc 031 §2) comes from PPL's own code list `GET
 * /codelist/status` (Czech names, read from the TEST environment on 2026-10-20) — never from an
 * English name or from `shipmentState`.
 */
describe('PPL tracking codes', () => {
  it('only 150/151 prove a pickup and 450–453 a delivery', () => {
    expect([150, 151].map(pplMeaning)).toEqual(['PICKED_UP', 'PICKED_UP']);
    expect([450, 451, 452, 453].map(pplMeaning)).toEqual(Array(4).fill('DELIVERED'));
  });

  it('"Čekáme na přijetí" (900; its English name says "received") is data only', () => {
    expect(pplMeaning(900)).toBe('DATA');
  });

  it('a pick-up point, a failed attempt, a loss or a return is never a delivery', () => {
    expect([343, 461, 992].map(pplMeaning)).toEqual(Array(3).fill('PICKUP_POINT'));
    expect([458, 460, 470].map(pplMeaning)).toEqual(Array(3).fill('NOT_DELIVERED'));
    expect([705, 997].map(pplMeaning)).toEqual(['LOST', 'LOST']);
    expect([336, 480, 718].map(pplMeaning)).toEqual(Array(3).fill('RETURNING'));
  });

  it('moving within PPL (incl. 710 "převzali do přepravy", asked of PPL) is not taken as the pickup', () => {
    expect([282, 300, 400, 405, 500, 710].map(pplMeaning)).toEqual(Array(6).fill('IN_TRANSIT'));
  });

  it('an unlisted or missing code stays unknown', () => {
    expect(pplMeaning(31337)).toBe('UNKNOWN');
    expect(pplMeaning(null)).toBe('UNKNOWN');
  });

  it('reads the events as the TEST environment returned them; an event without a time is dropped', () => {
    const { events, dropped } = pplEvents({
      trackAndTrace: {
        events: [
          {
            statusId: 999,
            code: 'Deleted.Cancelled',
            phase: 'Deleted',
            group: 'Deleted',
            eventDate: '2026-10-20T15:07:32+02:00',
            name: 'Zásilka je stornována v systému PPL.',
          },
          { statusId: '150', eventDate: '2026-10-21T10:00:00Z' },
          { statusId: 450 },
        ],
      },
    });
    expect(dropped).toBe(1);
    expect(events).toEqual([
      {
        statusId: 999,
        code: 'Deleted.Cancelled',
        phase: 'Deleted',
        group: 'Deleted',
        name: 'Zásilka je stornována v systému PPL.',
        occurredAt: new Date('2026-10-20T13:07:32Z'),
        meaning: 'CANCELLED',
      },
      {
        statusId: 150,
        code: null,
        phase: null,
        group: null,
        name: null,
        occurredAt: new Date('2026-10-21T10:00:00Z'),
        meaning: 'PICKED_UP',
      },
    ]);
    expect(pplEvents({}).events).toEqual([]);
    expect(pplEvents({ trackAndTrace: null }).events).toEqual([]);
  });
});
