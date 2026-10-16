import type { BottleStatus, LabelPrintJobStatus } from '@ayvo/types';
import { StatusBadge, type StatusTone } from '@ayvo/ui';
import { productionCs } from '@/i18n/cs/production';

const printJobTone: Record<LabelPrintJobStatus, StatusTone> = {
  PENDING: 'neutral',
  GENERATING: 'warning',
  COMPLETED: 'ok',
  FAILED: 'error',
};

export function PrintJobStatus({ status }: { status: LabelPrintJobStatus }) {
  return (
    <StatusBadge tone={printJobTone[status]}>
      {productionCs.printJobStatus[status] ?? status}
    </StatusBadge>
  );
}

const bottleTone: Record<BottleStatus, StatusTone> = {
  CREATED: 'neutral',
  LABELED_EMPTY: 'ok',
  FILLED: 'ok',
};

export function BottleStatusBadge({ status }: { status: BottleStatus }) {
  return (
    <StatusBadge tone={bottleTone[status] ?? 'neutral'}>
      {productionCs.bottleStatus[status] ?? status}
    </StatusBadge>
  );
}
