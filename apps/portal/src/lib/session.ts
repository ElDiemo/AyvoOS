import 'server-only';
import { cookies } from 'next/headers';

/**
 * The portal's cookies (ADR 0045 §7): `__Host-` — host-only, Secure, Path=/, so no other host can
 * set or overwrite them — HttpOnly and SameSite=Strict. They hold the core's tokens; the browser
 * never sees anything else of the session.
 */
export const SESSION_COOKIE = '__Host-ayvo_portal';
export const PRE_COOKIE = '__Host-ayvo_portal_pre';
/**
 * A sign-out the core has not confirmed yet (review 5818694161): the session token, kept only so
 * the sign-out can be retried. No page reads it as a session. It lives as long as a portal session
 * can (the absolute limit, 24 h); the core's own expiry ends the session anyway.
 */
export const LOGOUT_PENDING_COOKIE = '__Host-ayvo_portal_out';
export const LOGOUT_PENDING_SECONDS = 24 * 60 * 60;

const attributes = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' } as const;

export async function readCookie(name: string): Promise<string | null> {
  return (await cookies()).get(name)?.value ?? null;
}

export async function setCookie(name: string, value: string, maxAgeSeconds: number) {
  (await cookies()).set(name, value, { ...attributes, maxAge: Math.floor(maxAgeSeconds) });
}

export async function clearCookie(name: string) {
  (await cookies()).set(name, '', { ...attributes, maxAge: 0 });
}
