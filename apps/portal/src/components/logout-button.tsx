'use client';

import { useState } from 'react';
import { cs } from '@/i18n/cs';

/**
 * Signing out. portal-web ends local access at once whatever the core answers (review
 * 5818694161); a sign-out the core did not confirm is shown on the sign-in page, which offers to
 * finish it. Only when portal-web itself cannot be reached is nothing changed — and said so here.
 */
export function LogoutButton() {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        className="rounded-md px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-200"
        onClick={async () => {
          setFailed(false);
          const res = await fetch('/auth/logout', { method: 'POST' }).catch(() => null);
          if (!res || (res.status !== 204 && res.status !== 503)) {
            setFailed(true);
            return;
          }
          // A full load drops all client state; the sign-in page tells an unconfirmed sign-out.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load drops all client state after the session ended
          window.location.assign('/login');
        }}
      >
        {cs.nav.logout}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-red-700">
          {cs.logout.failed}
        </span>
      )}
    </span>
  );
}
