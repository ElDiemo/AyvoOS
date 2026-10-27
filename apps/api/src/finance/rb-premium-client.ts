import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request, type RequestOptions } from 'node:https';
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls';
import type { BankEnvironment, BankSyncError } from '@ayvo/types';
import type { FinanceEnv } from './finance-env.js';
import { parseTransactionPage, UnexpectedBankAnswer, type BankEntry } from './rb-premium-entry.js';
import { RB_BASE_PATH, RB_SIMULATION_HOST, RB_SIMULATION_PORT } from './rb-simulation.js';

/**
 * Read-only client of Raiffeisenbank Premium API (N3B-1, doc 041): only the documented
 * `GET …/accounts/{accountNumber}/{currencyCode}/transactions` with `from`, `to` and `page`.
 * mTLS with the client certificate (PKCS#12 + its password) and `X-IBM-Client-Id`; the bank's URLs
 * are fixed here, never configurable outside tests. No payment, batch or statement call exists.
 * Bounded: every request has a deadline and a size limit; 429, 5xx and network failures are
 * retried at most twice with a growing pause, anything else is the answer. Secrets are read from
 * their files per use and never logged, returned or stored.
 */
export const RB_PREMIUM_URLS = {
  production: 'https://api.rb.cz/rbcz/premium/api',
  sandbox: 'https://api.rb.cz/rbcz/premium/mock',
  /** The DEV bank simulation (its own CA, never the bank). */
  simulation: `https://${RB_SIMULATION_HOST}:${RB_SIMULATION_PORT}${RB_BASE_PATH}`,
} as const;

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const RETRIES = 2;

export class BankFailure extends Error {
  constructor(
    readonly code: BankSyncError,
    /** Secret-free, short; shown to the ADMIN. */
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface RbAccount {
  accountNumber: string;
  currency: string;
}

export interface RbPremiumConfig {
  environment: BankEnvironment;
  baseUrl: string;
  clientIdFile: string;
  p12File: string;
  passphraseFile: string;
  caFile: string | null;
  /** Tests of the simulation only: where to connect (the certificate is still verified by name). */
  connectTo: { host: string; port: number } | null;
  accounts: RbAccount[];
  timeoutMs: number;
  /** One run's deadline and in-memory bounds (review N3B75-R1/R2). */
  runDeadlineMs: number;
  maxWindowBytes: number;
  maxWindowEntries: number;
  /** Pause before retry n (1-based), in ms. */
  retryDelayMs: (attempt: number) => number;
}

/** The configured connection, or null when this installation has none. */
export function rbPremiumConfig(env: FinanceEnv): RbPremiumConfig | null {
  const mode = env.RB_PREMIUM_ENVIRONMENT;
  if (!mode) return null;
  return {
    // The simulation is not the bank: its movements are TEST data, never PRODUCTION or SANDBOX.
    environment: mode === 'production' ? 'PRODUCTION' : mode === 'sandbox' ? 'SANDBOX' : 'TEST',
    baseUrl: mode === 'test' ? env.RB_PREMIUM_BASE_URL_FOR_TESTS! : RB_PREMIUM_URLS[mode],
    clientIdFile: env.RB_PREMIUM_CLIENT_ID_FILE!,
    p12File: env.RB_PREMIUM_P12_FILE!,
    passphraseFile: env.RB_PREMIUM_P12_PASSPHRASE_FILE!,
    caFile:
      (mode === 'simulation'
        ? env.RB_PREMIUM_SIMULATION_CA_FILE
        : env.RB_PREMIUM_CA_FILE_FOR_TESTS) ?? null,
    connectTo:
      mode === 'simulation' && env.RB_PREMIUM_SIMULATION_ADDRESS_FOR_TESTS
        ? (([host, port]) => ({ host: host!, port: Number(port) }))(
            env.RB_PREMIUM_SIMULATION_ADDRESS_FOR_TESTS.split(':'),
          )
        : null,
    accounts: env.RB_PREMIUM_ACCOUNTS!.split(',').map((a) => {
      const [accountNumber, currency] = a.split(':') as [string, string];
      return { accountNumber, currency };
    }),
    timeoutMs: env.RB_PREMIUM_TIMEOUT_MS,
    runDeadlineMs: env.RB_PREMIUM_RUN_DEADLINE_MS,
    maxWindowBytes: env.RB_PREMIUM_MAX_WINDOW_BYTES,
    maxWindowEntries: env.RB_PREMIUM_MAX_WINDOW_ENTRIES,
    retryDelayMs: (n) => env.RB_PREMIUM_RETRY_BASE_MS * 2 ** (n - 1),
  };
}

const readSecret = (path: string) => readFileSync(path, 'utf8').replace(/\r?\n$/, '');

/** The certificate loaded with its password; any problem is CERTIFICATE_UNUSABLE (no detail leaks). */
function secureContext(cfg: RbPremiumConfig): SecureContext {
  try {
    return createSecureContext({
      pfx: readFileSync(cfg.p12File),
      passphrase: readSecret(cfg.passphraseFile),
      ...(cfg.caFile ? { ca: readFileSync(cfg.caFile) } : {}),
      minVersion: 'TLSv1.2',
    });
  } catch {
    throw new BankFailure(
      'CERTIFICATE_UNUSABLE',
      'Certifikát nelze načíst (soubor nebo heslo k němu).',
    );
  }
}

/** Whether the certificate file opens with its password, and its own expiry — nothing else. */
export function certificateState(cfg: RbPremiumConfig | null): {
  state: 'NOT_CONFIGURED' | 'READABLE' | 'UNREADABLE';
  notAfter: string | null;
} {
  if (!cfg) return { state: 'NOT_CONFIGURED', notAfter: null };
  try {
    const cert = new TLSSocket(null as never, {
      secureContext: secureContext(cfg),
    }).getCertificate();
    const validTo = cert && 'valid_to' in cert ? Date.parse(cert.valid_to) : NaN;
    return {
      state: 'READABLE',
      notAfter: Number.isNaN(validTo) ? null : new Date(validTo).toISOString(),
    };
  } catch {
    return { state: 'UNREADABLE', notAfter: null };
  }
}

type Answer = { status: number; body: string; bytes: number };

/** What one request may still use of its run: bytes of the window left, and the run's deadline. */
export interface RequestBudget {
  maxBytes: number;
  /** Epoch ms. */
  deadline: number;
}

const runTimeout = () =>
  new BankFailure('RUN_TIMEOUT', 'Načtení nestihlo skončit v časovém limitu; nic nebylo uloženo.');
const tooMuchData = () =>
  new BankFailure(
    'TOO_MUCH_DATA',
    'Odpovědi banky překročily povolený objem jednoho načtení; nic nebylo uloženo.',
  );

export class RbPremiumClient {
  constructor(private readonly cfg: RbPremiumConfig) {}

  /**
   * One page of posted transactions (including intraday) of the account × currency between two
   * days (the bank's own day boundaries, CET). 204 = no such page / nothing. Never reads more than
   * the budget's bytes and never waits past its deadline (pauses before retries included).
   */
  async transactions(
    account: RbAccount,
    from: string,
    to: string,
    page: number,
    budget: RequestBudget,
  ): Promise<{ lastPage: boolean; entries: BankEntry[]; bytes: number }> {
    const url = new URL(
      `${this.cfg.baseUrl}/accounts/${encodeURIComponent(account.accountNumber)}/${encodeURIComponent(account.currency)}/transactions`,
    );
    url.search = new URLSearchParams({ from, to, page: String(page) }).toString();
    const answer = await this.getWithRetry(url, budget);
    if (answer.status === 204) return { lastPage: true, entries: [], bytes: answer.bytes };
    try {
      return { ...parseTransactionPage(answer.body), bytes: answer.bytes };
    } catch (e) {
      if (e instanceof UnexpectedBankAnswer)
        throw new BankFailure('UNEXPECTED_RESPONSE', `Banka odpověděla nečekaně: ${e.message}.`);
      throw e;
    }
  }

  private async getWithRetry(url: URL, budget: RequestBudget): Promise<Answer> {
    for (let attempt = 0; ; attempt++) {
      const left = budget.deadline - Date.now();
      if (left <= 0) throw runTimeout();
      let answer: Answer | null = null;
      let networkFailure: string | null = null;
      try {
        answer = await this.get(url, Math.min(this.cfg.timeoutMs, left), budget.maxBytes);
      } catch (e) {
        if (e instanceof BankFailure) throw e;
        if (Date.now() >= budget.deadline) throw runTimeout();
        networkFailure = e instanceof Error && e.message === 'timeout' ? 'timeout' : 'network';
      }
      const retryable = answer === null || answer.status === 429 || answer.status >= 500;
      if (!retryable) return classify(answer!);
      if (attempt >= RETRIES) {
        if (answer?.status === 429)
          throw new BankFailure('RATE_LIMITED', 'Banka dočasně omezila počet dotazů (429).');
        throw new BankFailure(
          'BANK_UNAVAILABLE',
          answer
            ? `Banka je nedostupná (HTTP ${answer.status}).`
            : networkFailure === 'timeout'
              ? 'Banka neodpověděla včas.'
              : 'Spojení s bankou selhalo.',
        );
      }
      const pause = this.cfg.retryDelayMs(attempt + 1);
      if (Date.now() + pause >= budget.deadline) throw runTimeout();
      await new Promise((r) => setTimeout(r, pause));
    }
  }

  private get(url: URL, timeoutMs: number, maxBytes: number): Promise<Answer> {
    // One answer is bounded by its own limit and by what is left of the run's window.
    const limit = Math.min(MAX_BODY_BYTES, maxBytes);
    const context = secureContext(this.cfg);
    const clientId = readSecret(this.cfg.clientIdFile);
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          secureContext: context,
          // Tests of the simulation: connect elsewhere, verify the certificate for the fixed name.
          ...(this.cfg.connectTo
            ? {
                hostname: this.cfg.connectTo.host,
                port: this.cfg.connectTo.port,
                servername: url.hostname,
              }
            : {}),
          agent: false,
          headers: {
            Accept: 'application/json',
            'X-IBM-Client-Id': clientId,
            'X-Request-Id': randomUUID(),
          },
          timeout: timeoutMs,
          // Passed through to tls.connect (not in the https typings).
        } as RequestOptions & { secureContext: SecureContext },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limit) {
              req.destroy();
              reject(
                limit < MAX_BODY_BYTES
                  ? tooMuchData()
                  : new BankFailure('UNEXPECTED_RESPONSE', 'Odpověď banky je nepřiměřeně velká.'),
              );
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              bytes: size,
            }),
          );
          res.on('error', reject);
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        clearTimeout(deadline);
        // The bank refusing our certificate in the handshake is the certificate, not the network.
        const code = (e as NodeJS.ErrnoException).code ?? '';
        // (Only a TLS alert from the bank; a failed check of the bank's own certificate is not that.)
        if (/_ALERT_/.test(code))
          reject(
            new BankFailure(
              'CERTIFICATE_REJECTED',
              'Banka odmítla certifikát při navázání spojení (neplatný, zablokovaný nebo prošlý).',
            ),
          );
        else reject(e);
      });
      req.on('close', () => clearTimeout(deadline));
      req.end();
    });
  }
}

/** The documented answers (Swagger: 400 DT01, 401, 403, 404); anything else is unexpected. */
function classify(a: Answer): Answer {
  if (a.status === 200 || a.status === 204) return a;
  if (a.status === 401)
    throw new BankFailure(
      'CERTIFICATE_REJECTED',
      'Banka odmítla certifikát (neplatný, zablokovaný nebo prošlý). Odblokujte nebo obnovte ho v internetovém bankovnictví.',
    );
  if (a.status === 403)
    throw new BankFailure(
      'INSUFFICIENT_RIGHTS',
      'Certifikát nemá oprávnění číst pohyby tohoto účtu.',
    );
  if (a.status === 404)
    throw new BankFailure('ACCOUNT_NOT_FOUND', 'Banka tento účet a měnu nezná.');
  if (a.status === 400)
    throw new BankFailure(
      'REQUEST_REJECTED',
      'Banka odmítla rozsah dotazu (např. starší než 90 dní).',
    );
  throw new BankFailure('UNEXPECTED_RESPONSE', `Banka odpověděla nečekaně (HTTP ${a.status}).`);
}
