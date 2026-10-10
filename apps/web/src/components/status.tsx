import type { BottleStatus, LabelPrintJobStatus } from '@ayvo/types';
import { StatusBadge, type StatusTone } from '@ayvo/ui';

const printJobTone: Record<LabelPrintJobStatus, StatusTone> = {
  PENDING: 'neutral',
  GENERATING: 'warning',
  COMPLETED: 'ok',
  FAILED: 'error',
};

export function PrintJobStatus({ status }: { status: LabelPrintJobStatus }) {
  return <StatusBadge tone={printJobTone[status]}>{status}</StatusBadge>;
}

export function BottleStatusBadge({ status }: { status: BottleStatus }) {
  return <StatusBadge tone="neutral">{status}</StatusBadge>;
}
