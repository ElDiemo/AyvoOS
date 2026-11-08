'use client';

import { cs } from '@/i18n/cs';

/** Any failure without data (a contract unavailable): said plainly, nothing broader shown. */
export default function PortalError() {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-3 px-4 py-10">
      <h1 className="text-xl font-semibold">{cs.brand}</h1>
      <p role="alert" className="text-sm">
        {cs.unavailable}
      </p>
    </div>
  );
}
