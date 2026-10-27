import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

/**
 * A SIMULATED Raiffeisenbank Premium API for DEV (doc 041, doc 036 §10a): the same documented
 * `getTransactionList` the Finance client reads in production — mTLS with a client certificate
 * issued by the simulation's own CA, the `X-IBM-Client-Id` header, pages of
 * `{ lastPage, transactions }`, 204 past the last page, 400 DT01 for `from` older than 90 days and
 * 401 for a missing / foreign certificate or another client ID. It answers synthetic, deterministic
 * incoming payments (no real account, counterparty or amount) and holds no state.
 *
 * It runs only inside the DEV Compose project (`rb-simulation`, an internal network shared with
 * Finance alone), never with APP_ENV=production, and needs nothing from the real bank: its CA,
 * server and client certificates are generated on the DEV server by
 * scripts/dev-rb-simulation-certs.sh. Finance verifies its certificate like any other server.
 */
export const RB_SIMULATION_HOST = 'rb-simulation';
export const RB_SIMULATION_PORT = 8443;
export const RB_BASE_PATH = '/rbcz/premium/api';
const PAGE_SIZE = 50;

/** One entry as the bank writes it (the amount a JSON number exactly as given). */
export interface RbEntry {
  entryReference: string;
  /** Written as a JSON number exactly as this text. */
  amount: string;
  currency?: string;
  creditDebitIndication: 'CRDT' | 'DBIT';
  bookingDate?: string;
  valueDate?: string;
  code?: string;
  counterParty?: {
    name?: string;
    accountNumberPrefix?: string;
    accountNumber?: string;
    bankCode?: string;
    iban?: string;
  };
  variable?: string;
  constant?: string;
  specific?: string;
  message?: string;
}

/** One entry serialized as the bank does. */
export function entryJson(e: RbEntry, currency: string): string {
  const details = {
    transactionDetails: {
      ...(e.counterParty
        ? {
            relatedParties: {
              counterParty: {
                name: e.counterParty.name,
                ...(e.counterParty.bankCode
                  ? { organisationIdentification: { bankCode: e.counterParty.bankCode } }
                  : {}),
                account: {
                  iban: e.counterParty.iban,
                  accountNumberPrefix: e.counterParty.accountNumberPrefix,
                  accountNumber: e.counterParty.accountNumber,
                },
              },
            },
          }
        : {}),
      remittanceInformation: {
        unstructured: e.message,
        creditorReferenceInformation: {
          variable: e.variable,
          constant: e.constant,
          specific: e.specific,
        },
      },
    },
  };
  return JSON.stringify({
    entryReference: e.entryReference,
    amount: { value: JSON.rawJSON(e.amount), currency: e.currency ?? currency },
    creditDebitIndication: e.creditDebitIndication,
    bookingDate: e.bookingDate,
    valueDate: e.valueDate,
    bankTransactionCode: { code: e.code ?? '10000405000' },
    entryDetails: details,
  });
}

/**
 * The synthetic movements of an account between two days (inclusive, never after today): an
 * incoming payment every third day, amount and variable symbol derived from the day — the same
 * answer every time, so a repeated read finds nothing new.
 */
export function simulatedEntries(account: string, from: string, to: string, today: string) {
  const out: RbEntry[] = [];
  const last = to < today ? to : today;
  for (let d = new Date(`${last}T00:00:00Z`); ; d = new Date(d.getTime() - 86_400_000)) {
    const day = d.toISOString().slice(0, 10);
    if (day < from) break;
    const n = createHash('sha256').update(`${account}/${day}`).digest().readUInt32BE(0);
    if (n % 3 !== 0) continue;
    out.push({
      entryReference: `SIM-${account}-${day.replaceAll('-', '')}`,
      amount: `${1000 + (n % 9000)}.${String(n % 100).padStart(2, '0')}`,
      creditDebitIndication: 'CRDT',
      bookingDate: `${day}T00:00:00.000+02:00`,
      valueDate: `${day}T00:00:00.000+02:00`,
      counterParty: {
        name: 'Simulovaný plátce (DEV)',
        accountNumber: '1234567890',
        bankCode: '0100',
      },
      variable: day.replaceAll('-', ''),
      message: 'SIMULACE BANKY – NENÍ SKUTEČNÁ PLATBA',
    });
  }
  return out;
}

export interface RbSimulationOptions {
  key: Buffer;
  cert: Buffer;
  /** The simulation's CA: client certificates must be issued by it. */
  ca: Buffer;
  clientId: string;
  /** Accounts answered ("number:CUR", as RB_PREMIUM_ACCOUNTS); any other is 404. */
  accounts: string[];
  today?: () => string;
}

function send(res: ServerResponse, status: number, body?: string | object) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function rbSimulationServer(o: RbSimulationOptions): Server {
  const accounts = new Set(o.accounts.map((a) => a.replace(':', '/')));
  const today = o.today ?? (() => new Date().toISOString().slice(0, 10));
  return createServer(
    {
      key: o.key,
      cert: o.cert,
      ca: o.ca,
      // As documented by the bank: a missing / invalid client certificate is answered with 401.
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
    (req: IncomingMessage, res: ServerResponse) => {
      if (!(req.socket as TLSSocket).authorized) return send(res, 401, { error: 'UNAUTHORISED' });
      if (req.headers['x-ibm-client-id'] !== o.clientId)
        return send(res, 401, { error: 'UNAUTHORISED', error_description: 'invalid client id' });
      const url = new URL(req.url ?? '/', `https://${RB_SIMULATION_HOST}`);
      const m = new RegExp(`^${RB_BASE_PATH}/accounts/(\\d{1,10})/([A-Z]{3})/transactions$`).exec(
        url.pathname,
      );
      if (req.method !== 'GET' || !m) return send(res, 404, { error: 'ID_NOT_FOUND' });
      if (!accounts.has(`${m[1]}/${m[2]}`)) return send(res, 404, { error: 'ID_NOT_FOUND' });
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
        return send(res, 400, { error: 'DT01', error_description: 'invalid date' });
      if (Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 90 * 86_400_000)
        return send(res, 400, { error: 'DT01', error_description: 'older than 90 days' });
      const page = Number(url.searchParams.get('page') ?? '1');
      if (!Number.isInteger(page) || page < 1) return send(res, 400, { error: 'FORMAT' });
      const all = simulatedEntries(m[1]!, from, to, today());
      const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      if (slice.length === 0 && page > 1) return send(res, 204);
      const lastPage = page * PAGE_SIZE >= all.length;
      send(
        res,
        200,
        `{"lastPage":${lastPage},"transactions":[${slice.map((e) => entryJson(e, m[2]!)).join(',')}]}`,
      );
    },
  );
}
