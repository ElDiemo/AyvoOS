import 'server-only';
import { PORTAL_SESSION_HEADER } from '@ayvo/types';
import type { z } from 'zod';
import { portalEnv } from './env';

/** Contract timeouts (ADR 0045 §8): 3 s per core call, 5 s per Finance call. */
const CORE_TIMEOUT_MS = 3_000;
const FINANCE_TIMEOUT_MS = 5_000;

/** The session is gone (or never was): the portal signs in again. */
export class PortalUnauthenticated extends Error {}
/** A refusal with its stable code (e.g. INVALID_LOGIN), passed on to the page. */
export class PortalRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** No usable answer (down, slow, malformed): fail closed, never a broader or cached answer. */
export class PortalUnavailable extends Error {}

type Unit = 'core' | 'finance';

/** The core's answers that mean "no session here" (as its access guard words them). */
const SESSION_CODES = new Set(['UNAUTHENTICATED', 'SESSION_EXPIRED', 'ACCOUNT_INACTIVE']);

function target(unit: Unit) {
  const env = portalEnv();
  return unit === 'core'
    ? {
        base: `${env.CORE_INTERNAL_URL}/api/internal/v1/portal`,
        token: env.PORTAL_CORE_TOKEN,
        timeout: CORE_TIMEOUT_MS,
      }
    : {
        base: `${env.FINANCE_INTERNAL_URL}/api/internal/v1/portal`,
        token: env.PORTAL_FINANCE_TOKEN,
        timeout: FINANCE_TIMEOUT_MS,
      };
}

/** A raw contract call: the unit's own token, the portal session forwarded when there is one. */
export async function contractFetch(
  unit: Unit,
  path: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
    session?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const t = target(unit);
  const signal = AbortSignal.any([
    AbortSignal.timeout(init.timeoutMs ?? t.timeout),
    ...(init.signal ? [init.signal] : []),
  ]);
  try {
    return await fetch(`${t.base}/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${t.token}`,
        ...(init.session ? { [PORTAL_SESSION_HEADER]: init.session } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    throw new PortalUnavailable();
  }
}

/** A JSON contract call, validated against its schema. */
export async function contractJson<T extends z.ZodType>(
  unit: Unit,
  path: string,
  schema: T,
  init: Parameters<typeof contractFetch>[2] = {},
): Promise<z.infer<T>> {
  const res = await contractFetch(unit, path, init);
  if (res.status === 204) return undefined as z.infer<T>;
  const body = (await res.json().catch(() => undefined)) as
    { code?: string; message?: string } | undefined;
  if (res.ok) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PortalUnavailable();
    return parsed.data;
  }
  // A session that is gone is "sign in again"; a refused sign-in step (INVALID_LOGIN, INVALID_MFA)
  // is the step's own answer. Our token refused (SERVICE_UNAUTHENTICATED) is a fault: unavailable.
  if (res.status === 401 && SESSION_CODES.has(body?.code ?? 'UNAUTHENTICATED'))
    throw new PortalUnauthenticated();
  if (
    [400, 401, 403, 404, 409, 429].includes(res.status) &&
    body?.code &&
    body.code !== 'SERVICE_UNAUTHENTICATED'
  )
    throw new PortalRefusal(res.status, body.code, body.message ?? '');
  throw new PortalUnavailable();
}
