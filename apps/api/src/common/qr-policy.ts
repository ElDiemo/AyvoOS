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
