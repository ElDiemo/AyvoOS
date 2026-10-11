'use client';

import { labelTemplateDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/lib/client-api';
import { buttonClass, ErrorNote } from '@/components/ui';
import { productionCs } from '@/i18n/cs/production';

const t = productionCs.templates;

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
          if (!archived && !window.confirm(t.archiveConfirm)) return;
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
            setError(
              productionCs.common.failed(
                e instanceof Error ? e.message : productionCs.common.unexpectedError,
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : archived ? t.restore : t.archive}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
