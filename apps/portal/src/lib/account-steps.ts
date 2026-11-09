import 'server-only';
import { portalChallengeStepSchema } from '@ayvo/types';
import { z } from 'zod';
import { answer, stateChanging } from './auth-route';
import { publicStep } from './auth-steps';
import { contractJson } from './backend';
import { clientOf } from './request';
import { clearCookie, PRE_COOKIE, readCookie, SESSION_COOKIE, setCookie } from './session';

const text = (max: number) => z.string().min(1).max(max);

/**
 * "Zabezpečení účtu": the signed-in account starts replacing its authenticator app. The same
 * guards as a sign-in step (the portal's origin, a step slot, bounded body); the session cookie is
 * forwarded to the core, which checks the password and a current code. The setup step's token goes
 * into `__Host-ayvo_portal_pre`; the ordinary `/auth/mfa` with a code of the new app finishes it
 * (every earlier session ends; the new one and the new recovery codes come back there).
 */
export const replaceMfa = (request: Request) =>
  publicStep(request, z.object({ password: text(1024), code: text(64) }), async (b) => {
    const session = await readCookie(SESSION_COOKIE);
    if (!session) return answer(401, { code: 'UNAUTHENTICATED' });
    const step = await contractJson('core', 'account/replace-mfa', portalChallengeStepSchema, {
      method: 'POST',
      body: { password: b.password, code: b.code, client: clientOf(request) },
      session,
    });
    await setCookie(PRE_COOKIE, step.challenge, step.maxAgeSeconds);
    return answer(200, { step: step.step, qrDataUrl: step.qrDataUrl, setupKey: step.setupKey });
  });

/**
 * "Odhlásit ze všech zařízení": the core ends every session of the account. Only after the core
 * confirmed it is this browser's session cookie dropped — on a failure the page says so and the
 * user is still signed in to try again (never a claim that the other devices are signed out).
 */
export const logoutAll = (request: Request) =>
  stateChanging(request, async () => {
    const session = await readCookie(SESSION_COOKIE);
    if (!session) return answer(401, { code: 'UNAUTHENTICATED' });
    await contractJson('core', 'account/logout-all', z.unknown(), {
      method: 'POST',
      body: { client: clientOf(request) },
      session,
    });
    await clearCookie(SESSION_COOKIE);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
