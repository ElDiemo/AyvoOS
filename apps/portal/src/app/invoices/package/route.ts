import {
  PORTAL_PACKAGE_MAX_ZIP_BYTES,
  portalInvoicePackageQuerySchema,
  portalSessionViewSchema,
} from '@ayvo/types';
import { contractJson, PortalUnauthenticated } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { passFile } from '@/lib/pdf-proxy';
import { readCookie, SESSION_COOKIE } from '@/lib/session';
import { KeyedSlotLimit, StartQuota } from '@/lib/slots';

export const dynamic = 'force-dynamic';

/**
 * Packages (review 6800881871; owner 2026-11-11 — fetched about once or twice a month): at most
 * one in transfer per portal account and PORTAL_PACKAGE_MAX_IN_FLIGHT in this process, on slots of
 * their own (never a PDF's); and their STARTS limited in time per account and in total
 * (StartQuota), so the number ever in transfer or parked in buffers on the way stays bounded
 * whatever a client's speed. Refused at once, before any byte, back to "Faktury" with the reason;
 * a start that passed nothing on is given back. Off (PORTAL_PACKAGE_ENABLED=0): not found.
 */
let packages: KeyedSlotLimit | null = null;
let starts: StartQuota | null = null;

/** Finance names the package by its period. */
const DISPOSITION = /^attachment; filename="AYVO-faktury-\d{4}-\d{2}-\d{4}-\d{2}\.zip"$/;

/**
 * "Balíček za období" (doc 040 §14): a ZIP of the visible invoices of the period from Finance,
 * passed through like a PDF (one deadline above Finance's own, counted bytes up to Finance's limit
 * plus the ZIP's small overhead). A refused period (invalid, empty, too large, busy) goes back to
 * "Faktury" with its reason; nothing else of Finance's answer is shown.
 */
export async function GET(request: Request) {
  const env = portalEnv();
  if (env.PORTAL_PACKAGE_ENABLED !== '1')
    return new Response('Nenalezeno', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  const url = new URL(request.url);
  // Back to the invoices with the reason. The Location is relative: behind the edge,
  // request.url names portal-web's own listener (e.g. 127.0.0.1:3200), never the public origin.
  const back = (reason: string) => {
    const query = new URLSearchParams({ balicek: reason });
    for (const k of ['from', 'to']) {
      const v = url.searchParams.get(k);
      if (v && /^\d{4}-\d{2}$/.test(v)) query.set(k, v);
    }
    return new Response(null, { status: 303, headers: { Location: `/invoices?${query}` } });
  };
  const q = portalInvoicePackageQuerySchema.safeParse({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  if (!q.success) return back('INVALID_PERIOD');
  // The account, from the core now (the package's slot is counted per account, never per session).
  const session = await readCookie(SESSION_COOKIE);
  let account: string | null = null;
  if (session) {
    try {
      account = (await contractJson('core', 'session', portalSessionViewSchema, { session })).user
        .id;
    } catch (error) {
      if (error instanceof PortalUnauthenticated)
        return new Response('Přihlaste se prosím znovu.', {
          status: 401,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      return back('UNAVAILABLE');
    }
  }
  packages ??= new KeyedSlotLimit(env.PORTAL_PACKAGE_MAX_IN_FLIGHT, 1);
  starts ??= new StartQuota({
    minIntervalMs: env.PORTAL_PACKAGE_ACCOUNT_INTERVAL_MINUTES * 60_000,
    perKeyPerDay: env.PORTAL_PACKAGE_ACCOUNT_PER_DAY,
    globalPerDay: env.PORTAL_PACKAGE_GLOBAL_PER_DAY,
  });
  // Without a session passFile answers 401 itself (no start is counted).
  const start = account ? starts.take(account) : null;
  if (start === 'RATE') return back('PACKAGE_RATE');
  if (start === 'DAILY') return back('PACKAGE_DAILY');
  if (start === 'GLOBAL') return back('PACKAGE_BUSY');
  return passFile(request, {
    acquire: () => {
      const release = account ? packages!.acquire(account) : null;
      if (!release) {
        start?.giveBack();
        return null;
      }
      // A refusal or no answer (nothing passed on) gives the start back.
      return (bytes: number) => {
        release();
        if (bytes === 0) start?.giveBack();
      };
    },
    unit: 'finance',
    path: `invoices/package?from=${q.data.from}&to=${q.data.to}`,
    type: 'application/zip',
    disposition: DISPOSITION,
    // The shared ceiling (Finance never sends more), and a little longer than Finance's deadline.
    maxBytes: PORTAL_PACKAGE_MAX_ZIP_BYTES,
    // Default: Finance's ceiling + grace; behind the PROD edge lower (PORTAL_PACKAGE_DEADLINE_MS).
    deadlineMs: env.PORTAL_PACKAGE_DEADLINE_MS,
    busy: 'Balíčky se teď připravují. Zkuste to za chvíli.',
    unavailable: 'Faktury nejsou dostupné.',
    refused: (status, code) =>
      back(
        status === 400
          ? 'INVALID_PERIOD'
          : code === 'BUSY' // portal-web's own slots are full
            ? 'PACKAGE_BUSY'
            : code && ['NO_INVOICES', 'PACKAGE_TOO_LARGE', 'PACKAGE_BUSY'].includes(code)
              ? code
              : 'UNAVAILABLE', // Finance unreachable or its answer unusable
      ),
  });
}
