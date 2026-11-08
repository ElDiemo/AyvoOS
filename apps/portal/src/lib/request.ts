import 'server-only';
import type { PortalClient } from '@ayvo/types';
import { portalEnv } from './env';

/**
 * The portal's CSRF rule (ADR 0045 §3): a state-changing request must name the portal itself as
 * its Origin, and a Sec-Fetch-Site, when sent, must be same-origin. No CORS exists.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (origin !== portalEnv().PORTAL_PUBLIC_ORIGIN) return false;
  return site === null || site === 'same-origin';
}

/**
 * The client's IP for the core's rate limits: the entry the portal's own reverse proxy appended
 * (the last one) when portal-web runs behind it, else the loopback of a local run. Never a value
 * the client chose for itself in front of the proxy.
 */
export function clientIp(request: Request): string {
  if (portalEnv().PORTAL_TRUST_PROXY === '1') {
    const forwarded = request.headers.get('x-forwarded-for');
    const last = forwarded?.split(',').at(-1)?.trim();
    if (last && /^[0-9a-fA-F:.]{2,45}$/.test(last)) return last;
  }
  return '127.0.0.1';
}

/** What the core checks again about the browser request (its own CSRF rule and rate limits). */
export function clientOf(request: Request): PortalClient {
  return {
    ip: clientIp(request),
    origin: request.headers.get('origin') ?? '',
    secFetchSite: request.headers.get('sec-fetch-site'),
  };
}
