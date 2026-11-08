import 'server-only';
import { portalChallengeStepSchema, portalMfaResultSchema } from '@ayvo/types';
import { z } from 'zod';
import { answer, stateChanging } from './auth-route';
import { contractJson } from './backend';
import { clientOf } from './request';
import { clearCookie, PRE_COOKIE, readCookie, SESSION_COOKIE, setCookie } from './session';

const text = (max: number) => z.string().min(1).max(max);
const credentials = z.object({ email: text(254), password: text(1024) });
const action = z.object({ token: z.string().length(43), password: text(1024) });

/** The browser's body, shape-checked here; the core validates it fully again. */
async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
const invalid = () => answer(400, { code: 'INVALID_REQUEST' });

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
  stateChanging(request, async () => {
    const b = await body(request, credentials);
    if (!b) return invalid();
    return challenge('auth/password', { ...b, client: clientOf(request) });
  });

export const activate = (request: Request) =>
  stateChanging(request, async () => {
    const b = await body(request, action);
    if (!b) return invalid();
    return challenge('auth/activate', { ...b, client: clientOf(request) });
  });

export const resetPassword = (request: Request) =>
  stateChanging(request, async () => {
    const b = await body(request, action);
    if (!b) return invalid();
    return challenge('auth/reset-password', { ...b, client: clientOf(request) });
  });

export const forgotPassword = (request: Request) =>
  stateChanging(request, async () => {
    const b = await body(request, z.object({ email: text(254) }));
    if (!b) return invalid();
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
  stateChanging(request, async () => {
    const b = await body(request, z.object({ code: text(64) }));
    if (!b) return invalid();
    const pending = await readCookie(PRE_COOKIE);
    if (!pending) return answer(401, { code: 'NO_PENDING_STEP' });
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

/** Ends the session at the core (an unknown one is simply not there) and drops the cookie. */
export const logout = (request: Request) =>
  stateChanging(request, async () => {
    const session = await readCookie(SESSION_COOKIE);
    if (session)
      await contractJson('core', 'auth/logout', z.unknown(), {
        method: 'POST',
        body: { client: clientOf(request) },
        session,
      }).catch(() => undefined);
    await clearCookie(SESSION_COOKIE);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
