import 'server-only';
import { portalHotelProfileSchema, portalHotelProfileUpdateSchema } from '@ayvo/types';
import { readInput } from './auth-input';
import { answer, stateChanging } from './auth-route';
import { contractJson } from './backend';
import { clientOf } from './request';
import { readCookie, SESSION_COOKIE } from './session';
import { SlotLimit } from './slots';

/**
 * "Profil hotelu" save (portal-web's only state-changing route outside /auth/*). The body may be
 * longer than a sign-in step (eleven fields, Czech text in UTF-8), so it has its own limits:
 * at most 8 KiB, read within 5 s, and at most 4 saves read or wait on the core at once in this
 * process (the rest 503 at once). The edge in front must allow POST on exactly this path with the
 * same size and time bounds (deploy/dev/Caddyfile).
 */
export const PROFILE_INPUT_MAX_BYTES = 8 * 1024;
const saves = new SlotLimit(4);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The portal's own origin first (CSRF), then a save slot, the session cookie, the body within its
 * limits and the whitelisted shape (strict: any other key is refused here already). The core
 * checks the forwarded browser request, the session and the grant on this hotel again.
 */
export function saveHotelProfile(request: Request, hotelId: string) {
  return stateChanging(request, async () => {
    if (!UUID.test(hotelId)) return answer(404, { code: 'HOTEL_NOT_FOUND' });
    const release = saves.acquire();
    if (!release) return answer(503, { code: 'PORTAL_UNAVAILABLE' });
    try {
      const session = await readCookie(SESSION_COOKIE);
      if (!session) {
        await request.body?.cancel().catch(() => undefined);
        return answer(401, { code: 'UNAUTHENTICATED' });
      }
      const input = await readInput(request, { maxBytes: PROFILE_INPUT_MAX_BYTES });
      if (input.kind === 'too-large') return answer(413, { code: 'REQUEST_TOO_LARGE' });
      if (input.kind === 'too-slow') return answer(408, { code: 'REQUEST_TIMEOUT' });
      const parsed =
        input.kind === 'ok' ? portalHotelProfileUpdateSchema.safeParse(input.value) : null;
      if (!parsed?.success)
        return answer(400, {
          code: 'INVALID_REQUEST',
          fields: [
            ...new Set(
              (parsed?.error.issues ?? []).flatMap((i) =>
                i.path[0] === 'profile' && typeof i.path[1] === 'string' ? [i.path[1]] : [],
              ),
            ),
          ],
        });
      const profile = await contractJson(
        'core',
        `hotels/${hotelId}/profile`,
        portalHotelProfileSchema,
        {
          method: 'POST',
          session,
          body: { ...parsed.data, client: clientOf(request) },
        },
      );
      return answer(200, profile);
    } finally {
      release();
    }
  });
}
