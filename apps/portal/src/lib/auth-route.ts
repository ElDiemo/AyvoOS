import 'server-only';
import { NextResponse } from 'next/server';
import { PortalRefusal, PortalUnauthenticated, PortalUnavailable } from './backend';
import { sameOrigin } from './request';

/** A JSON answer that is never cached. */
export function answer(status: number, body: unknown) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** A state-changing route: the portal's own origin only, contract errors mapped to their codes. */
export async function stateChanging(request: Request, work: () => Promise<Response>) {
  if (!sameOrigin(request)) return answer(403, { code: 'CSRF_REJECTED' });
  try {
    return await work();
  } catch (error) {
    if (error instanceof PortalRefusal) return answer(error.status, { code: error.code });
    if (error instanceof PortalUnauthenticated) return answer(401, { code: 'UNAUTHENTICATED' });
    if (error instanceof PortalUnavailable) return answer(503, { code: 'PORTAL_UNAVAILABLE' });
    throw error;
  }
}
