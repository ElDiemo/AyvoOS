import { NextResponse, type NextRequest } from 'next/server';

/**
 * 1. /api/*: the browser calls the API same-origin (ADR 0013). On the DEV preview Caddy routes
 *    /api to NestJS before a request ever reaches Next.js, so this branch never runs there.
 *    Locally (`pnpm dev`, Playwright) it plays Caddy's role and forwards /api/* unchanged to
 *    API_URL — read at runtime, so one build works against any API port; /api/admin/finance/* goes
 *    to FINANCE_API_URL (the Finance unit, ADR 0039), /api/internal/* nowhere.
 * 2. Pages: records the requested path in `x-ayvo-path` (overwriting anything the client sent),
 *    so a page can send the user back there after signing in.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    // The core's internal contract is never reachable from a browser (Caddy aborts it too).
    if (pathname.startsWith('/api/internal/')) return new NextResponse(null, { status: 404 });
    const finance = pathname === '/api/admin/finance' || pathname.startsWith('/api/admin/finance/');
    const apiUrl = finance
      ? (process.env.FINANCE_API_URL ?? 'http://localhost:4010')
      : (process.env.API_URL ?? 'http://localhost:4000');
    return NextResponse.rewrite(new URL(`${pathname}${search}`, apiUrl));
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-ayvo-path', `${pathname}${search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Must be a static literal (Next.js reads it at build time). Static assets are skipped.
export const config = {
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
