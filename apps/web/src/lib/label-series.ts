import type { BottleCreationHistoryItem } from '@ayvo/types';
import { productionCs } from '../i18n/cs/production';
import { codeRange } from './format';
import type { ActiveSeries } from './session-choice';

/**
 * The series an operator can label: only series whose labels a completed print job generated
 * (the server refuses any other label with LABEL_NOT_PRINTED anyway). Newest first, as listed.
 */
export function labelReadySeries(items: BottleCreationHistoryItem[]): ActiveSeries[] {
  return items
    .filter((s) => s.latestPrintJob?.status === 'COMPLETED')
    .map((s) => ({
      code: s.code,
      label: productionCs.labelActivation.seriesOption(
        s.labelTemplate.label,
        codeRange(s.firstBottleCode, s.lastBottleCode),
      ),
    }));
}
