import { NextResponse, type NextRequest } from 'next/server';

/**
 * The browser calls the API same-origin at /api/* (ADR 0013). On the DEV preview Caddy routes
 * /api to NestJS before a request ever reaches Next.js, so this never runs there. Locally
 * (`pnpm dev`, Playwright) it plays Caddy's role and forwards /api/* unchanged to API_URL —
 * read at runtime, so one build works against any API port.
 */
export function proxy(request: NextRequest) {
  const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
  const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, apiUrl);
  return NextResponse.rewrite(target);
}

// Must be a static literal (Next.js reads it at build time); equals `${API_BASE_PATH}/:path*`.
export const config = {
  matcher: ['/api/:path*'],
};
