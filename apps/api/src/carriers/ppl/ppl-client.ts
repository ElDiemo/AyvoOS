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

  private async accessToken(signal: AbortSignal): Promise<string> {
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
        signal,
      });
      if (!res.ok) throw new PplAuthError(res.status);
      const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string' || !body.access_token) throw new PplAuthError(0);
      const seconds = typeof body.expires_in === 'number' ? body.expires_in : 1800;
      // Renewed a minute early, never later than PPL says.
      this.token = {
        value: body.access_token,
        expiresAt: Date.now() + Math.max(seconds - 60, 30) * 1000,
      };
      return body.access_token;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** One API request; a 401 drops the token and is retried once (the request was not processed). */
  async request(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      query?: Record<string, string | number | (string | number)[]>;
      json?: unknown;
      signal: AbortSignal;
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
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      const type = res.headers.get('content-type') ?? '';
      const body = type.includes('json') ? await res.json().catch(() => null) : await res.text();
      return { status: res.status, headers: res.headers, body };
    }
    throw new PplAuthError(401);
  }

  /**
   * Downloads a label file from a URL PPL returned. Only the connection's own API origin and base
   * path are accepted; redirects are refused; the size is limited. Only then is the token sent.
   */
  async download(rawUrl: string, signal: AbortSignal): Promise<Uint8Array> {
    const url = new URL(rawUrl);
    const base = new URL(this.connection.baseUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
      throw new Error('PPL label URL outside the PPL API: refused');
    }
    const token = await this.accessToken(signal);
    await this.spaced();
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal,
    });
    if (res.status >= 300 && res.status < 400) throw new Error('PPL label redirect: refused');
    if (!res.ok || !res.body) throw new Error(`PPL label download: ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_FILE_BYTES) throw new Error('PPL label too large');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error('PPL label too large');
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}

/** Authentication failed (wrong or revoked credentials) — the message never contains them. */
export class PplAuthError extends Error {
  constructor(readonly status: number) {
    super(`PPL authentication failed${status ? ` (HTTP ${status})` : ''}`);
  }
}
