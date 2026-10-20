import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Evidence of a live carrier run (doc 029 §10): every exchange with the carrier as it really went
 * over the wire — the exact request body sent and the response received — appended to a JSON Lines
 * file OUTSIDE any git worktree, so it survives the per-run test database. Never recorded: the
 * token request and response, any Authorization header, credential or token values (also scrubbed
 * from every string), phone numbers and e-mail addresses. A line that would still contain a known
 * secret is refused, never written.
 */

const SECRET_KEY = /token|secret|password|authorization|client_?id|api_?key/i;
const PERSONAL_KEY = /phone|e-?mail|mobile/i;
const EMAIL = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g;
const TOKEN_PATH = /\/login\/getAccessToken$/;

export const REDACTED = '[redacted]';
export const REDACTED_PERSONAL = '[redacted: personal]';

/** A copy of `value` with secrets and personal contact data removed (keys and string contents). */
export function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const secret of secrets) if (secret) s = s.split(secret).join(REDACTED);
    return s.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`).replace(EMAIL, REDACTED_PERSONAL);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        v === null || v === undefined || v === ''
          ? v
          : SECRET_KEY.test(k)
            ? REDACTED
            : PERSONAL_KEY.test(k)
              ? REDACTED_PERSONAL
              : redact(v, secrets),
      ]),
    );
  }
  return value;
}

/** The directory must not lie inside a git worktree (evidence never lands in the repository). */
function assertOutsideGit(dir: string) {
  let d = realpathSync(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) {
      throw new Error(`Exchange log directory ${dir} is inside a git worktree (${d})`);
    }
    const up = dirname(d);
    if (up === d) return;
    d = up;
  }
}

export interface ExchangeLog {
  readonly file: string;
  /** Wraps a fetch implementation: records each exchange, returns the response untouched. */
  wrap(fetchImpl: typeof fetch): typeof fetch;
}

export function createExchangeLog(
  dir: string,
  secrets: readonly string[],
  runId = new Date().toISOString().replace(/[:.]/g, '-'),
): ExchangeLog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertOutsideGit(dir);
  const file = join(resolve(dir), `exchanges-${runId}.jsonl`);
  const known = secrets.filter((s) => s.length >= 4);
  let seq = 0;

  const write = (entry: object) => {
    const line = JSON.stringify(redact(entry, known));
    if (known.some((s) => line.includes(s))) throw new Error('Exchange log line kept a secret');
    // Appended synchronously, line by line: what was sent is on disk before the answer arrives.
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  };

  const requestBody = (path: string, body: RequestInit['body']) => {
    if (TOKEN_PATH.test(path)) return '[token request – not recorded]';
    if (body === undefined || body === null) return null;
    if (typeof body !== 'string') return '[non-text body – not recorded]';
    try {
      return { json: JSON.parse(body) as unknown, sha256: sha256(body) };
    } catch {
      return { text: body, sha256: sha256(body) };
    }
  };

  async function responseBody(path: string, res: Response) {
    const bytes = Buffer.from(await res.clone().arrayBuffer());
    if (TOKEN_PATH.test(path)) {
      // The token is never written; it joins the values scrubbed from everything after it.
      try {
        const t = (JSON.parse(bytes.toString('utf8')) as { access_token?: unknown }).access_token;
        if (typeof t === 'string' && t.length >= 4) known.push(t);
      } catch {
        // no token in the answer: nothing to scrub
      }
      return '[token response – not recorded]';
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      try {
        return { json: JSON.parse(bytes.toString('utf8')) as unknown, bytes: bytes.length };
      } catch {
        return { text: bytes.toString('utf8'), bytes: bytes.length };
      }
    }
    if (type.startsWith('text/')) return { text: bytes.toString('utf8'), bytes: bytes.length };
    // Binary (labels): identified, not copied — the files themselves are kept separately.
    return { bytes: bytes.length, sha256: sha256(bytes) };
  }

  return {
    file,
    wrap(fetchImpl) {
      return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const n = ++seq;
        const method = (init?.method ?? 'GET').toUpperCase();
        const base = { seq: n, method, host: url.host, path: url.pathname, query: url.search };
        write({
          ...base,
          phase: 'sent',
          at: new Date().toISOString(),
          contentType: new Headers(init?.headers).get('content-type'),
          body: requestBody(url.pathname, init?.body),
        });
        let res: Response;
        try {
          res = await fetchImpl(input, init);
        } catch (error) {
          write({
            ...base,
            phase: 'failed',
            at: new Date().toISOString(),
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          throw error;
        }
        write({
          ...base,
          phase: 'received',
          at: new Date().toISOString(),
          status: res.status,
          headers: {
            'content-type': res.headers.get('content-type'),
            location: res.headers.get('location'),
          },
          body: await responseBody(url.pathname, res),
        });
        return res;
      }) as typeof fetch;
    },
  };
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
