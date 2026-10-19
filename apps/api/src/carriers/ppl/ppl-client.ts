import { CarrierProtocolError } from '../carrier.js';

/**
 * HTTP client of the PPL CPL API (ppl-cpl-api.apidog.io, read 2026-10-19). One instance per
 * server-side connection. The OAuth2 token (client credentials, scope myapi2, valid 30 min, at most
 * 12 tokens/min) is reused until shortly before it expires and requested by one caller at a time.
 * Credentials and tokens are never logged, returned or stored. Requests keep PPL's minimum spacing
 * (40 ms). Label files are downloaded only from the connection's own API origin and path, without
 * following redirects, size-limited — the Bearer token never goes anywhere else.
 */

export interface PplConnection {
  code: string;
  environment: 'TEST' | 'PRODUCTION';
  /** Fixed in code per environment (tests may point it to a simulated server). */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface PplResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

const MIN_SPACING_MS = 40;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The shared token request has its own time limit — one caller's abort never fails the others. */
const TOKEN_TIMEOUT_MS = 30_000;

/** A short, secret-free description of a PPL error body (problem+json). */
export function pplProblem(body: unknown): string {
  if (!body || typeof body !== 'object') return 'PPL error';
  const p = body as { title?: unknown; detail?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof p.title === 'string') parts.push(p.title);
  if (typeof p.detail === 'string') parts.push(p.detail);
  if (p.errors && typeof p.errors === 'object') {
    for (const [field, messages] of Object.entries(p.errors as Record<string, unknown>)) {
      const list = Array.isArray(messages) ? messages.filter((m) => typeof m === 'string') : [];
      parts.push(`${field}: ${list.join(', ')}`);
    }
  }
  return (parts.join('; ') || 'PPL error').slice(0, 900);
}

export class PplClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastAt = 0;

  constructor(
    readonly connection: PplConnection,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Keeps PPL's minimum spacing between two consecutive requests of this connection. */
  private spaced(): Promise<void> {
    const next = this.queue.then(async () => {
      const wait = this.lastAt + MIN_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * A valid token (cached or new). Throws {@link PplAuthError} when PPL refuses the credentials and
   * {@link PplUnavailableError} otherwise — in both cases nothing else was sent to PPL.
   */
  async accessToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.pending ??= (async () => {
      await this.spaced();
      const res = await this.fetchImpl(`${this.connection.baseUrl}/login/getAccessToken`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.connection.clientId,
          client_secret: this.connection.clientSecret,
          scope: 'myapi2',
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      }).catch(() => {
        throw new PplUnavailableError('PPL token endpoint unreachable');
      });
      if ([400, 401, 403].includes(res.status)) throw new PplAuthError(res.status);
      if (!res.ok) throw new PplUnavailableError(`PPL token endpoint: HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof body.access_token !== 'string' || !body.access_token) {
        throw new PplUnavailableError('PPL token endpoint: no token in the answer');
      }
      const seconds =
        typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 1800;
      // Renewed a minute early (half-way for short tokens) — never later than PPL says.
      this.token = {
        value: body.access_token,
        expiresAt: Date.now() + (seconds > 120 ? seconds - 60 : seconds / 2) * 1000,
      };
      return body.access_token;
    })().finally(() => {
      this.pending = null;
    });
    const shared = this.pending;
    shared.catch(() => undefined); // a caller that gave up never leaves a rejection unhandled
    // Each caller still honours its own signal while waiting for the shared request.
    return await Promise.race([
      shared,
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }),
      ),
    ]);
  }

  /**
   * One API request. A 401 on a read drops the token and is retried once. A creating request
   * (`once: true`) is never repeated: its 401 is returned to the caller (PPL did not process it).
   */
  async request(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      query?: Record<string, string | number | (string | number)[]>;
      json?: unknown;
      signal: AbortSignal;
      once?: boolean;
    },
  ): Promise<PplResponse> {
    const url = new URL(`${this.connection.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(opts.signal);
      await this.spaced();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        redirect: 'manual',
        signal: opts.signal,
      });
      if (res.status === 401 && attempt === 0 && !opts.once) {
        this.token = null;
        continue;
      }
      if (res.status === 401) this.token = null;
      const type = res.headers.get('content-type') ?? '';
      const body = type.includes('json') ? await res.json().catch(() => null) : await res.text();
      return { status: res.status, headers: res.headers, body };
    }
    throw new PplAuthError(401);
  }

  /**
   * Downloads a label file from a URL PPL returned (absolute, or relative to the API host). Only the
   * connection's own origin and its `/data/` path are accepted; redirects are refused; the size is
   * limited. Only then is the token sent. A violation is a {@link CarrierProtocolError} (a person
   * checks it — it is not retried).
   */
  async download(rawUrl: string, signal: AbortSignal): Promise<Uint8Array> {
    const base = new URL(this.connection.baseUrl);
    let url: URL;
    try {
      url = new URL(rawUrl, base.origin);
    } catch {
      throw new CarrierProtocolError('PPL returned an unusable label URL');
    }
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname}/data/`) ||
      url.username ||
      url.password
    ) {
      throw new CarrierProtocolError('PPL label URL outside the PPL API: refused');
    }
    const token = await this.accessToken(signal);
    await this.spaced();
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new CarrierProtocolError('PPL label redirect: refused');
    }
    if (!res.ok || !res.body) throw new Error(`PPL label download: ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_FILE_BYTES) throw new CarrierProtocolError('PPL label too large');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new CarrierProtocolError('PPL label too large');
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}

/** PPL (or its token endpoint) could not be reached or answered unusably; nothing was sent. */
export class PplUnavailableError extends Error {}

/** Authentication refused (wrong or revoked credentials) — the message never contains them. */
export class PplAuthError extends Error {
  constructor(readonly status: number) {
    super(`PPL authentication failed${status ? ` (HTTP ${status})` : ''}`);
  }
}
