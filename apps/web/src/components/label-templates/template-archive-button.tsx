'use client';

import { labelTemplateDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/lib/client-api';
import { buttonClass, ErrorNote } from '@/components/ui';

/**
 * Archive (hide) or restore a template. Archived templates keep every version for reproducing
 * historical labels but cannot be selected for new bottles. Templates are never deleted.
 */
export function TemplateArchiveButton({
  templateId,
  archived,
}: {
  templateId: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={busy}
        onClick={async () => {
          if (
            !archived &&
            !window.confirm('Archive this template? It can no longer be used for new bottles.')
          )
            return;
          setBusy(true);
          setError(null);
          try {
            await apiSend(
              'POST',
              `admin/label-templates/${templateId}/${archived ? 'restore' : 'archive'}`,
              labelTemplateDetailSchema,
            );
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : archived ? 'Restore template' : 'Archive template'}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
