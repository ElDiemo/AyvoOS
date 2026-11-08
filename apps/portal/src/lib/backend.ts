import 'server-only';
import { PORTAL_SESSION_HEADER } from '@ayvo/types';
import type { z } from 'zod';
import { portalEnv } from './env';
import { contentLengthWithin, deadline, readBounded, SlotLimit } from './slots';

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

/**
 * portal-web's own request limit per receiver (ADR 0045 §8: "keep-alive 8 / 4"): at most 8 calls to
 * the core and 4 to Finance in flight from this process, counted until the answer's body has been
 * read or released. Beyond that a call is refused at once (503), never queued.
 */
const UNIT_SLOTS: Record<Unit, SlotLimit> = { core: new SlotLimit(8), finance: new SlotLimit(4) };
/** The largest JSON answer portal-web reads from a contract (checked while reading). */
export const CONTRACT_JSON_MAX_BYTES = 1024 * 1024;

/** For tests and diagnostics: the calls in flight per receiver. */
export const contractCallsInFlight = () => ({
  core: UNIT_SLOTS.core.inFlight,
  finance: UNIT_SLOTS.finance.inFlight,
});

export interface ContractCall {
  res: Response;
  /** The call's single deadline (the caller's, or the unit's own timeout). */
  signal: AbortSignal;
  /** Ends the call: the unit's timer and its slot. Run after the body is read or cancelled. */
  finish: () => void;
}

/**
 * A raw contract call holding one of the receiver's slots: the unit's own token, the portal
 * session forwarded when there is one. `signal`, when given, is the caller's single deadline for
 * the whole request (it then replaces the unit's timeout); otherwise the unit's timeout covers
 * the fetch and the reading of the answer. The caller must `finish()` it.
 */
export async function contractOpen(
  unit: Unit,
  path: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
    session?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<ContractCall> {
  const t = target(unit);
  const releaseSlot = UNIT_SLOTS[unit].acquire();
  if (!releaseSlot) throw new PortalUnavailable();
  const own = init.signal ? null : deadline(t.timeout);
  const signal = init.signal ?? own!.signal;
  const finish = () => {
    own?.done();
    releaseSlot();
  };
  try {
    const res = await fetch(`${t.base}/${path}`, {
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
    return { res, signal, finish };
  } catch {
    finish();
    throw new PortalUnavailable();
  }
}

/** Reads a JSON answer within the byte limit and the call's deadline; undefined if not JSON. */
async function readJson(call: ContractCall): Promise<unknown> {
  const { res, signal } = call;
  if (!contentLengthWithin(res.headers.get('content-length'), CONTRACT_JSON_MAX_BYTES)) {
    await res.body?.cancel().catch(() => undefined);
    throw new PortalUnavailable();
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(res.body, { maxBytes: CONTRACT_JSON_MAX_BYTES, stop: signal });
  } catch {
    throw new PortalUnavailable();
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON contract call, validated against its schema. */
export async function contractJson<T extends z.ZodType>(
  unit: Unit,
  path: string,
  schema: T,
  init: Parameters<typeof contractOpen>[2] = {},
): Promise<z.infer<T>> {
  const call = await contractOpen(unit, path, init);
  const { res } = call;
  let body: { code?: string; message?: string } | undefined;
  try {
    if (res.status === 204) {
      await res.body?.cancel().catch(() => undefined);
      return undefined as z.infer<T>;
    }
    body = (await readJson(call)) as typeof body;
  } finally {
    call.finish();
  }
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
