import 'server-only';
import { portalChallengeStepSchema } from '@ayvo/types';
import { z } from 'zod';
import { answer } from './auth-route';
import { publicStep } from './auth-steps';
import { contractJson } from './backend';
import { clientOf } from './request';
import { PRE_COOKIE, readCookie, SESSION_COOKIE, setCookie } from './session';

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
