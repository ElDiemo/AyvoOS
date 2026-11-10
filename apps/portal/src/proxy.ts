import { NextResponse, type NextRequest } from 'next/server';
import { cspFor } from './lib/csp';

/**
 * The portal's Content Security Policy for its pages (review 5818694161; Next.js guide
 * "Content Security Policy", nonces with Proxy). Every page answer gets a fresh nonce: only
 * scripts that carry it (Next.js and React's own, which Next.js marks from the request's CSP
 * header) and what they load (`'strict-dynamic'`) may run — no `'unsafe-inline'`, no
 * `'unsafe-eval'` outside `next dev`. Pages are rendered per request (the root layout waits for
 * `connection()`), so no build-time page carries a stale nonce.
 *
 * The routes /auth/*, /hotels/<id>/profile (the profile save) and the files (/invoices/<id>/pdf,
 * /invoices/package) do NOT pass through here: a proxy makes Next.js buffer the request body for
 * it, which would bypass portal-web's own input limits on the sign-in steps and the profile save.
 * They answer JSON or a file and get a fixed, script-free policy from next.config.ts.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64');
  const csp = cspFor(nonce, {
    dev: process.env.NODE_ENV === 'development',
    https: process.env.PORTAL_PUBLIC_ORIGIN?.startsWith('https://') ?? true,
  });
  const requestHeaders = new Headers(request.headers);
  // Next.js reads the nonce from the request's CSP header while rendering.
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.delete('x-nonce');
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

// Must be a static literal (Next.js reads it at build time). Skipped: static assets, and the
// route handlers that read a body or stream a file (see above). Nothing is skipped by request
// header (review 5818871541): `Purpose: prefetch` or `Next-Router-Prefetch: 1` come from the client
// and do not prove the answer is an RSC payload — a page answered with them is full HTML and gets
// its own nonce policy like any other.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|auth/|invoices/[^/]+/pdf|invoices/package|hotels/[^/]+/profile).*)',
  ],
};
