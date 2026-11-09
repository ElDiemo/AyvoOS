import 'server-only';
import { portalChallengeStepSchema, portalMfaResultSchema } from '@ayvo/types';
import { z } from 'zod';
import { acquireAuthStep, readInput } from './auth-input';
import { answer, stateChanging } from './auth-route';
import { contractJson, PortalUnauthenticated } from './backend';
import { clientOf } from './request';
import {
  clearCookie,
  MAX_PENDING_LOGOUTS,
  PRE_COOKIE,
  readCookie,
  readPendingLogouts,
  SESSION_COOKIE,
  setCookie,
  writePendingLogouts,
} from './session';

const text = (max: number) => z.string().min(1).max(max);
const credentials = z.object({ email: text(254), password: text(1024) });
const action = z.object({ token: z.string().length(43), password: text(1024) });

const invalid = () => answer(400, { code: 'INVALID_REQUEST' });

/**
 * A public sign-in step (review 5818694161): the portal's own origin, then one of the public step
 * slots (503 at once when all are busy), then the body within its byte and time limits — and only
 * then a shape check and the core. Nothing of an oversized, slow or malformed body reaches the
 * core, and the slot is given back as soon as the step ends (also when it was cut).
 */
export function publicStep<T extends z.ZodType>(
  request: Request,
  schema: T,
  work: (body: z.infer<T>) => Promise<Response>,
) {
  return stateChanging(request, async () => {
    const release = acquireAuthStep();
    if (!release) return answer(503, { code: 'PORTAL_UNAVAILABLE' });
    try {
      const input = await readInput(request);
      if (input.kind === 'too-large') return answer(413, { code: 'REQUEST_TOO_LARGE' });
      if (input.kind === 'too-slow') return answer(408, { code: 'REQUEST_TIMEOUT' });
      const parsed = input.kind === 'ok' ? schema.safeParse(input.value) : null;
      if (!parsed?.success) return invalid();
      return await work(parsed.data);
    } finally {
      release();
    }
  });
}

/** A pre-session step: its token goes into `__Host-ayvo_portal_pre`, the page gets the rest. */
async function challenge(path: string, payload: Record<string, unknown>) {
  const step = await contractJson('core', path, portalChallengeStepSchema, {
    method: 'POST',
    body: payload,
  });
  await setCookie(PRE_COOKIE, step.challenge, step.maxAgeSeconds);
  return answer(200, { step: step.step, qrDataUrl: step.qrDataUrl, setupKey: step.setupKey });
}

export const password = (request: Request) =>
  publicStep(request, credentials, (b) =>
    challenge('auth/password', { ...b, client: clientOf(request) }),
  );

export const activate = (request: Request) =>
  publicStep(request, action, (b) =>
    challenge('auth/activate', { ...b, client: clientOf(request) }),
  );

export const resetPassword = (request: Request) =>
  publicStep(request, action, (b) =>
    challenge('auth/reset-password', { ...b, client: clientOf(request) }),
  );

export const forgotPassword = (request: Request) =>
  publicStep(request, z.object({ email: text(254) }), async (b) => {
    const r = await contractJson(
      'core',
      'auth/forgot-password',
      z.object({ message: z.string() }),
      {
        method: 'POST',
        body: { email: b.email, client: clientOf(request) },
      },
    );
    return answer(200, r);
  });

/** The second factor: a session into `__Host-ayvo_portal`, or a finished password reset. */
export const mfa = (request: Request) =>
  publicStep(request, z.object({ code: text(64) }), async (b) => {
    const pending = await readCookie(PRE_COOKIE);
    if (!pending) return answer(401, { code: 'NO_PENDING_STEP' });
    // No new session while this browser cannot remember one more unfinished sign-out (review
    // 5818871541): signing out of the new session must still be able to end the older ones.
    if ((await readPendingLogouts()).length >= MAX_PENDING_LOGOUTS) {
      return answer(409, { code: 'LOGOUT_INCOMPLETE' });
    }
    const r = await contractJson('core', 'auth/mfa', portalMfaResultSchema, {
      method: 'POST',
      body: { challenge: pending, code: b.code, client: clientOf(request) },
    });
    await clearCookie(PRE_COOKIE);
    if (r.step === 'PASSWORD_RESET') {
      await clearCookie(SESSION_COOKIE);
      return answer(200, { step: 'PASSWORD_RESET' });
    }
    await setCookie(SESSION_COOKIE, r.session, r.maxAgeSeconds);
    return answer(200, { step: 'DONE', recoveryCodes: r.recoveryCodes });
  });

/**
 * Signing out (reviews 5818694161, 5818871541). Local access ends at once, always: the session
 * cookie is dropped before the core is asked, so no page of this browser uses the session again.
 * The action ends **every** session this browser still has to end — the current one and each
 * earlier sign-out the core has not confirmed (a new sign-in after a failed sign-out must not hide
 * the older session) — and the answer says truthfully whether the core ended all of them:
 * - **204** — the core confirmed each one (or it was already gone there: logout is idempotent, so a
 *   retry after an answer lost past the core's commit lands here); only then is the retry state
 *   removed;
 * - **503 LOGOUT_INCOMPLETE** — the core could not be reached or refused for at least one. Exactly
 *   those session tokens are kept in `__Host-ayvo_portal_out` (HttpOnly; no page reads it as a
 *   session), and the login page offers to finish signing out, which retries them.
 */
export const logout = (request: Request) =>
  stateChanging(request, async () => {
    const current = await readCookie(SESSION_COOKIE);
    const targets = [...new Set([...(current ? [current] : []), ...(await readPendingLogouts())])];
    await clearCookie(SESSION_COOKIE);
    const unfinished: string[] = [];
    for (const session of targets) {
      if (!(await endAtCore(request, session))) unfinished.push(session);
    }
    await writePendingLogouts(unfinished);
    if (unfinished.length > 0) return answer(503, { code: 'LOGOUT_INCOMPLETE' });
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });

/** True when the core ended the session now or no longer knows it. */
async function endAtCore(request: Request, session: string): Promise<boolean> {
  try {
    await contractJson('core', 'auth/logout', z.unknown(), {
      method: 'POST',
      body: { client: clientOf(request) },
      session,
    });
    return true;
  } catch (error) {
    return error instanceof PortalUnauthenticated;
  }
}
