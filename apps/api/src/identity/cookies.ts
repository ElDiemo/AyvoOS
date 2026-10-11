import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'ayvo_session';
/** Binds an OAuth login attempt to the browser that started it (callback CSRF protection). */
export const LOGIN_BINDING_COOKIE = 'ayvo_login';

/** Reads one cookie from the request header. Only cookies identify a session — never headers. */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * A session cookie: HttpOnly (no script access), Secure, SameSite=Lax (sent on the top-level
 * redirect back from the identity provider, never on cross-site POSTs), whole site.
 */
export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join('; ');
}

export function clearCookie(name: string): string {
  return serializeCookie(name, '', 0);
}
