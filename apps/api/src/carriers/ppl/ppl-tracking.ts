import type { CarrierTrackingEvent, TrackingMeaning } from '../carrier.js';

/**
 * What a PPL tracking event means for AYVO (doc 031 §2). The meaning comes from PPL's own code
 * list `GET /codelist/status` (read from the PPL TEST environment on 2026-10-20, Czech names,
 * evidence in doc 031) — keyed by the event's numeric `statusId`, which matches the code list's
 * `code`. It is never guessed from an English name, from `shipmentState` (a set of flags that
 * reads "Undelivered" for a parcel PPL never had) or from the textual event `code`.
 *
 * Only two meanings change AYVO's states:
 * - PICKED_UP — 150, 151 „Zásilku jsme převzali od odesílatele.“
 * - DELIVERED — 450, 451, 452, 453 „Zásilku jsme doručili příjemci.“
 * Everything else is history and, where it signals a problem, a warning. A code not listed here
 * stays UNKNOWN (shown with its code, changes nothing).
 */
const MEANINGS: Record<number, TrackingMeaning> = {
  // Data only — PPL has not got the parcel.
  900: 'DATA', // Čekáme na přijetí zásilky do přepravy.
  933: 'DATA', // Aktivace zásilky
  // Physically received from the sender.
  150: 'PICKED_UP', // Zásilku jsme převzali od odesílatele.
  151: 'PICKED_UP', // Zásilku jsme převzali od odesílatele.
  // Moving within PPL — NOT counted as the pickup (PPL question Q1, doc 031 §4).
  282: 'IN_TRANSIT', // Zásilka směřuje do cílové destinace.
  300: 'IN_TRANSIT', // Zásilka se nachází na doručujícím depu.
  400: 'IN_TRANSIT', // Zásilka připravena k doručení.
  405: 'IN_TRANSIT', // Zásilka se dnes doručuje.
  500: 'IN_TRANSIT', // Zásilka je v přepravě.
  710: 'IN_TRANSIT', // Zásilku jsme převzali do přepravy. (Q1: is this a pickup?)
  // Delivered to the recipient.
  450: 'DELIVERED', // Zásilku jsme doručili příjemci.
  451: 'DELIVERED',
  452: 'DELIVERED',
  453: 'DELIVERED',
  // At a pick-up point — not a delivery to the hotel.
  343: 'PICKUP_POINT', // Zásilku jsme doručili na výdejní místo.
  461: 'PICKUP_POINT', // Zásilku připravíme k osobnímu odběru.
  992: 'PICKUP_POINT', // Doručeno - Poste restante
  // Not delivered (an attempt failed or was refused) — a warning, never a delivery.
  454: 'NOT_DELIVERED',
  455: 'NOT_DELIVERED',
  456: 'NOT_DELIVERED',
  457: 'NOT_DELIVERED',
  458: 'NOT_DELIVERED',
  459: 'NOT_DELIVERED',
  460: 'NOT_DELIVERED', // Zásilku budeme doručovat v jiném termínu.
  462: 'NOT_DELIVERED', // Zásilku budeme doručovat na novou adresu.
  463: 'NOT_DELIVERED',
  464: 'NOT_DELIVERED',
  465: 'NOT_DELIVERED',
  466: 'NOT_DELIVERED',
  467: 'NOT_DELIVERED',
  468: 'NOT_DELIVERED',
  469: 'NOT_DELIVERED',
  470: 'NOT_DELIVERED', // Nedoručeno - Žádost odesílatele
  471: 'NOT_DELIVERED',
  476: 'NOT_DELIVERED',
  993: 'NOT_DELIVERED',
  // Lost.
  705: 'LOST', // Zásilka nebyla doručena z důvodu ztráty.
  997: 'LOST', // Nedoručeno - Zásilka ztracena
  // Going back to the sender.
  336: 'RETURNING',
  480: 'RETURNING',
  718: 'RETURNING', // Zásilka bude vrácena zpět odesílateli.
  // Cancelled in PPL's system.
  999: 'CANCELLED',
};

/** Meanings shown as a warning on the order (problems of the transport). */
export const WARNING_MEANINGS: TrackingMeaning[] = ['NOT_DELIVERED', 'LOST', 'RETURNING'];

export function pplMeaning(statusId: number | null): TrackingMeaning {
  return statusId !== null ? (MEANINGS[statusId] ?? 'UNKNOWN') : 'UNKNOWN';
}

interface PplEvent {
  statusId?: unknown;
  code?: unknown;
  phase?: unknown;
  group?: unknown;
  eventDate?: unknown;
  name?: unknown;
}

const text = (v: unknown, max = 300): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/**
 * The events of one `GET /shipment` item (`trackAndTrace.events`), in PPL's own terms plus our
 * meaning. An event without a valid date is dropped (it could not be ordered or de-duplicated) and
 * counted, so the caller can say so; nothing is invented.
 */
export function pplEvents(item: { trackAndTrace?: { events?: unknown } | null }): {
  events: CarrierTrackingEvent[];
  dropped: number;
} {
  const raw = item.trackAndTrace?.events;
  const list = Array.isArray(raw) ? (raw as PplEvent[]) : [];
  const events: CarrierTrackingEvent[] = [];
  let dropped = 0;
  for (const e of list) {
    const at = typeof e.eventDate === 'string' ? new Date(e.eventDate) : null;
    if (!at || Number.isNaN(at.getTime())) {
      dropped += 1;
      continue;
    }
    const statusId =
      typeof e.statusId === 'number' && Number.isInteger(e.statusId)
        ? e.statusId
        : typeof e.statusId === 'string' && /^\d{1,6}$/.test(e.statusId)
          ? Number(e.statusId)
          : null;
    events.push({
      statusId,
      code: text(e.code, 100),
      phase: text(e.phase, 100),
      group: text(e.group, 100),
      name: text(e.name),
      occurredAt: at,
      meaning: pplMeaning(statusId),
    });
  }
  return { events, dropped };
}
