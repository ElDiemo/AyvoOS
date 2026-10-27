import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { entryJson, RB_BASE_PATH, type RbEntry } from '../../src/finance/rb-simulation.js';

/**
 * A SIMULATED Raiffeisenbank Premium API for automated tests only (N3B-1, doc 041) — the
 * documented `getTransactionList` (Swagger v1.1.20240910): mTLS with a client certificate, the
 * `X-IBM-Client-Id` header, pages of `{ lastPage, transactions }`, 204 past the last page, 400 DT01
 * for `from` older than 90 days, 401 / 403 / 404 / 429 bodies `{ error, error_description }`.
 * Amounts are written as JSON numbers exactly as given (e.g. 1500.50). Everything is generated
 * per run in a temporary directory — its own CA, the server certificate for localhost, a client
 * certificate (PKCS#12 with an obviously fake password) and one from a foreign CA. No real bank
 * host, certificate or account is ever involved.
 */
export const BASE_PATH = RB_BASE_PATH;

/** One entry as the bank writes it (the shape the DEV simulation answers too). */
export type FakeEntry = RbEntry;

/** What the next requests answer instead of the list: a status, or 'hang' (never answer). */
type Fault = number | 'hang';

export class FakeRb {
  readonly dir = mkdtempSync(join(tmpdir(), 'ayvo-fake-rb-'));
  readonly clientId = `fake-rb-client-${randomUUID()}`;
  readonly passphrase = 'fake-rb-test-password-not-a-secret';
  /** Accounts ("number/CUR") and their entries, newest first like a bank list. */
  readonly accounts = new Map<string, FakeEntry[]>();
  /** Accounts the certificate may not read (403 INSUFFICIENT_RIGHTS). */
  readonly forbidden = new Set<string>();
  /** The certificate was blocked / revoked at the bank (401 UNAUTHORISED). */
  revoked = false;
  pageSize = 2;
  /** Pages from this one on answer 503 (a failure in the middle of a window). */
  failFromPage: number | null = null;
  readonly faults: Fault[] = [];
  /** Every request that reached the API (after the TLS handshake). */
  readonly requests: { path: string; query: URLSearchParams; clientId: string | undefined }[] = [];
  /** Bytes of every body sent (to show that each page alone was within a limit). */
  readonly responseBytes: number[] = [];
  private pendingHold: { arrived: () => void; released: Promise<void> } | null = null;
  /** A raw body for the next 200 answer (malformed answers). */
  rawNext: string | null = null;
  private server: Server | null = null;
  private readonly hanging = new Set<ServerResponse>();

  constructor() {
    const run = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: this.dir, stdio: 'ignore' });
    const ca = (name: string) => {
      run(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.crt`,
        '-days',
        '2',
        '-subj',
        `/CN=AYVO test ${name}`,
      );
    };
    ca('ca');
    ca('foreign-ca');
    const leaf = (name: string, issuer: string, subject: string, ext?: string) => {
      run(
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        subject,
      );
      if (ext) writeFileSync(join(this.dir, `${name}.ext`), ext);
      run(
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        `${issuer}.crt`,
        '-CAkey',
        `${issuer}.key`,
        '-CAcreateserial',
        '-out',
        `${name}.crt`,
        '-days',
        '2',
        ...(ext ? ['-extfile', `${name}.ext`] : []),
      );
    };
    leaf('server', 'ca', '/CN=localhost', 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    leaf('client', 'ca', '/CN=AYVO test client');
    leaf('foreign', 'foreign-ca', '/CN=AYVO test foreign client');
    for (const name of ['client', 'foreign'])
      run(
        'pkcs12',
        '-export',
        '-inkey',
        `${name}.key`,
        '-in',
        `${name}.crt`,
        '-out',
        `${name}.p12`,
        '-passout',
        `pass:${this.passphrase}`,
      );
    writeFileSync(join(this.dir, 'client-id'), `${this.clientId}\n`);
    writeFileSync(join(this.dir, 'passphrase'), `${this.passphrase}\n`);
    writeFileSync(join(this.dir, 'wrong-passphrase'), 'wrong\n');
  }

  file(
    name: 'ca.crt' | 'client.p12' | 'foreign.p12' | 'client-id' | 'passphrase' | 'wrong-passphrase',
  ) {
    return join(this.dir, name);
  }

  /**
   * The next request waits (a live, paused run) until `release()`; it is then answered from the
   * data as they are at that moment.
   */
  holdNext(): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const arrivedP = new Promise<void>((r) => (arrived = r));
    const released = new Promise<void>((r) => (release = r));
    this.pendingHold = { arrived, released };
    return { arrived: arrivedP, release };
  }

  get base() {
    const { port } = this.server!.address() as AddressInfo;
    return `https://localhost:${port}${BASE_PATH}`;
  }

  /** The Finance environment pointing at this simulation. */
  env(accounts: string, over: Record<string, string> = {}): Record<string, string> {
    return {
      RB_PREMIUM_ENVIRONMENT: 'test',
      RB_PREMIUM_BASE_URL_FOR_TESTS: this.base,
      RB_PREMIUM_CA_FILE_FOR_TESTS: this.file('ca.crt'),
      RB_PREMIUM_CLIENT_ID_FILE: this.file('client-id'),
      RB_PREMIUM_P12_FILE: this.file('client.p12'),
      RB_PREMIUM_P12_PASSPHRASE_FILE: this.file('passphrase'),
      RB_PREMIUM_ACCOUNTS: accounts,
      RB_PREMIUM_RETRY_BASE_MS: '100',
      RB_PREMIUM_TIMEOUT_MS: '1500',
      ...over,
    };
  }

  async start() {
    this.server = createServer(
      {
        key: readFileSync(join(this.dir, 'server.key')),
        cert: readFileSync(join(this.dir, 'server.crt')),
        ca: readFileSync(join(this.dir, 'ca.crt')),
        // As documented by the bank: a missing / invalid client certificate is answered with
        // 401 ("certificate's serial number is missing or in an invalid state"), not a reset.
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => void this.handle(req, res),
    );
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
  }

  async stop() {
    for (const res of this.hanging) res.destroy();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    this.responseBytes.push(Buffer.byteLength(text));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'https://localhost');
    const clientId = req.headers['x-ibm-client-id'] as string | undefined;
    this.requests.push({ path: url.pathname, query: url.searchParams, clientId });
    const hold = this.pendingHold;
    if (hold) {
      this.pendingHold = null;
      hold.arrived();
      await hold.released;
    }
    if (!(req.socket as TLSSocket).authorized)
      return this.send(res, 401, { error: 'UNAUTHORISED' });
    const fault = this.faults.shift();
    if (fault === 'hang') {
      this.hanging.add(res);
      return;
    }
    if (fault !== undefined)
      return this.send(
        res,
        fault,
        fault === 429 ? { error: 'TOO_MANY_REQUESTS' } : 'Service Unavailable',
      );
    if (clientId !== this.clientId || this.revoked)
      return this.send(res, 401, { error: 'UNAUTHORISED', error_description: 'invalid' });
    const m = new RegExp(`^${BASE_PATH}/accounts/(\\d{1,10})/([A-Z]{3})/transactions$`).exec(
      url.pathname,
    );
    if (req.method !== 'GET' || !m) return this.send(res, 404, { error: 'ID_NOT_FOUND' });
    const key = `${m[1]}/${m[2]}`;
    const entries = this.accounts.get(key);
    if (!entries) return this.send(res, 404, { error: 'ID_NOT_FOUND' });
    if (this.forbidden.has(key)) return this.send(res, 403, { error: 'INSUFFICIENT_RIGHTS' });
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return this.send(res, 400, { error: 'DT01', error_description: 'invalid date' });
    if (Date.now() - Date.parse(`${from}T00:00:00Z`) > 91 * 86_400_000)
      return this.send(res, 400, { error: 'DT01', error_description: 'older than 90 days' });
    const page = Number(url.searchParams.get('page') ?? '1');
    if (this.failFromPage !== null && page >= this.failFromPage)
      return this.send(res, 503, 'Service Unavailable');
    const inWindow = entries.filter((e) => {
      const d = (e.bookingDate ?? e.valueDate ?? '').slice(0, 10);
      return d === '' || (d >= from && d <= to);
    });
    const slice = inWindow.slice((page - 1) * this.pageSize, page * this.pageSize);
    if (slice.length === 0 && page > 1) return this.send(res, 204);
    if (this.rawNext !== null) {
      const raw = this.rawNext;
      this.rawNext = null;
      return this.send(res, 200, raw);
    }
    const lastPage = page * this.pageSize >= inWindow.length;
    this.send(
      res,
      200,
      `{"lastPage":${lastPage},"transactions":[${slice.map((e) => entryJson(e, m[2]!)).join(',')}]}`,
    );
  }
}
