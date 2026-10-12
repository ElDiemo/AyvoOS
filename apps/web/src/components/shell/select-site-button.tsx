'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui';
import { selectSite } from './site-switcher';

export function SelectSiteButton({
  siteId,
  next,
  label,
}: {
  siteId: string;
  next: string;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={buttonClass.primary}
      onClick={async () => {
        setBusy(true);
        try {
          await selectSite(siteId, next);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}
