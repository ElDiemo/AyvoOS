'use client';

import { useState } from 'react';
import { cs } from '@/i18n/cs';

/**
 * A sign-out the core has not confirmed (review 5818694161): this browser no longer uses the
 * session, but it may still be valid on the server until signing out is finished (or it expires).
 * "Dokončit odhlášení" repeats the same idempotent call.
 */
export function LogoutPending() {
  const [state, setState] = useState<'pending' | 'busy' | 'still'>('pending');
  return (
    <div
      role="status"
      data-testid="logout-pending"
      className="flex flex-col gap-2 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900"
    >
      <p>{state === 'still' ? cs.logout.stillPending : cs.logout.pending}</p>
      <button
        type="button"
        disabled={state === 'busy'}
        className="self-start rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        onClick={async () => {
          setState('busy');
          const res = await fetch('/auth/logout', { method: 'POST' }).catch(() => null);
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load drops all client state after the session ended
          if (res?.status === 204) window.location.assign('/login');
          else setState('still');
        }}
      >
        {cs.logout.finish}
      </button>
    </div>
  );
}
