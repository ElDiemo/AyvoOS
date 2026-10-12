import request from 'supertest';
import type { TestApp } from './test-app.js';

/** The migrated initial site that owns every pre-existing warehouse (doc 022 §9). */
export const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * Signs a pre-provisioned user in through the fake identity provider (APP_ENV=test) — the real
 * login → provider → callback flow — and returns the `Cookie` header value of the new session.
 */
export async function sessionCookie(t: TestApp, email: string): Promise<string> {
  const http = () => request(t.app.getHttpServer());
  const start = await http().get('/api/auth/login').query({ next: '/', login_hint: email });
  const binding = /ayvo_login=([^;]+)/.exec(String(start.headers['set-cookie']))?.[1];
  if (start.status !== 302 || !binding) throw new Error(`login failed: ${start.status}`);
  const authorize = new URL(start.headers.location!);
  const provider = await http().get(authorize.pathname + authorize.search);
  const callback = new URL(provider.headers.location!);
  const done = await http()
    .get(callback.pathname + callback.search)
    .set('Cookie', `ayvo_login=${binding}`);
  const token = /ayvo_session=([^;]+)/.exec(String(done.headers['set-cookie']))?.[1];
  if (!token) throw new Error(`sign-in of ${email} failed: ${done.headers.location}`);
  return `ayvo_session=${token}`;
}
