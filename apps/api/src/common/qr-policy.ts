/**
 * DEV/production QR separation (ADR 0014). A production process may only encode the production
 * QR host; any other process must never encode it. The same rule is enforced at startup (env),
 * when a print job is created, when it is rendered, and by a CHECK constraint in PostgreSQL
 * (`label_print_jobs_qr_environment_check`, `ayvo_url_host`).
 *
 * PRODUCTION_QR_BASE_URL is a SECURITY-POLICY VALUE, not configuration: it is never used as a
 * default, preview or fallback. Changing the production QR domain is an intentional code change
 * plus a database migration (ADR 0014).
 */
export const PRODUCTION_QR_BASE_URL = 'https://qr.ayvo.co';
const PRODUCTION_QR_HOST = 'qr.ayvo.co';

export type AppEnvironment = 'development' | 'test' | 'production';

export class QrUrlPolicyError extends Error {}

/** Lower-cased host without port or trailing dot; null if the URL cannot be parsed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** True for any URL whose host is the production QR host or one of its subdomains. */
export function pointsAtProductionQrHost(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return host === PRODUCTION_QR_HOST || (host?.endsWith(`.${PRODUCTION_QR_HOST}`) ?? false);
}

/** Returns why `baseUrl` may not be used for labels in `appEnv`, or null if it may. */
export function qrBaseUrlViolation(appEnv: AppEnvironment, baseUrl: string): string | null {
  if (appEnv === 'production') {
    return baseUrl === PRODUCTION_QR_BASE_URL
      ? null
      : `Refusing to generate labels: production requires the public QR base URL ${PRODUCTION_QR_BASE_URL}`;
  }
  return pointsAtProductionQrHost(baseUrl)
    ? `Refusing to generate labels: a ${appEnv} process must never encode a production QR URL`
    : null;
}

export function assertQrBaseUrlAllowed(appEnv: AppEnvironment, baseUrl: string): void {
  const violation = qrBaseUrlViolation(appEnv, baseUrl);
  if (violation) throw new QrUrlPolicyError(violation);
}

/** The public URL encoded in a QR code: `<base>/<token>`. */
export function publicQrUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/${token}`;
}

/** Visible on every label rendered outside production. */
export const DEV_LABEL_MARKER = 'DEV - NOT FOR PRODUCTION';

/** Domain of every AYVO QR host, in any environment (dev.ayvo.co, qr.ayvo.co, …). */
const AYVO_DOMAIN = 'ayvo.co';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type ScannedQr =
  | { kind: 'TOKEN'; url: string; token: string }
  /** An AYVO QR URL of another environment (e.g. a production label scanned on DEV). */
  | { kind: 'WRONG_ENVIRONMENT' }
  | { kind: 'NOT_AYVO_QR' };

/**
 * Classifies raw scanner input for physical label application (doc 018 §7). Only surrounding
 * whitespace and CR/LF (scanner terminators) are removed; host, path, token and case are never
 * rewritten. Accepted is exactly `<this environment's base URL>/<22-char token>`; a raw token, a
 * bottle code or any altered URL is not.
 */
export function classifyScannedQr(raw: string, baseUrl: string): ScannedQr {
  const value = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const prefix = `${baseUrl}/`;
  if (value.startsWith(prefix) && TOKEN_PATTERN.test(value.slice(prefix.length))) {
    return { kind: 'TOKEN', url: value, token: value.slice(prefix.length) };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'NOT_AYVO_QR' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ayvoHost = host === AYVO_DOMAIN || host.endsWith(`.${AYVO_DOMAIN}`);
  const looksLikeLabel =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    TOKEN_PATTERN.test(url.pathname.split('/').pop() ?? '');
  // Same host as this environment but not the exact URL: altered input, never "repaired".
  if (!ayvoHost || !looksLikeLabel || host === hostOf(baseUrl)) return { kind: 'NOT_AYVO_QR' };
  return { kind: 'WRONG_ENVIRONMENT' };
}
