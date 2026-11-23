'use client';

import { labelTemplateDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/lib/client-api';
import { buttonClass } from '@/components/ui';
import { productionCs } from '@/i18n/cs/production';
import { productionError, ProductionErrorNote, type ProductionError } from '../production-errors';

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
  const [error, setError] = useState<ProductionError | null>(null);
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
            setError(productionError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : archived ? t.restore : t.archive}
      </button>
      {error && <ProductionErrorNote error={error} />}
    </div>
  );
}
