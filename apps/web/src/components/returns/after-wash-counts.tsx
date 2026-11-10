'use client';

import { afterWashQueueSchema, type AfterWashQueue } from '@ayvo/types';
import { useEffect, useState } from 'react';
import { Stat } from '@/components/ui';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet } from '@/lib/client-api';

const c = returnsCs.cycle.afterWash;

/**
 * The Po mytí counts on the Oběh lahví overview, a panel of their own (review 5841814857): a
 * failing queue read only says its counts are unavailable — never a 0 it did not get, and never
 * takes the overview (or the way to Příjem vratek) down with it.
 */
export function AfterWashCounts() {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; counts: AfterWashQueue['counts'] } | { kind: 'down' }
  >({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    apiGet('admin/returns/after-wash', afterWashQueueSchema).then(
      (q) => live && setState({ kind: 'ok', counts: q.counts }),
      () => live && setState({ kind: 'down' }),
    );
    return () => {
      live = false;
    };
  }, []);
  if (state.kind === 'down')
    return (
      <p className="mb-4 text-sm text-amber-800" data-testid="cycle-counts-unavailable">
        {c.countsUnavailable}
      </p>
    );
  const value = (n: (k: AfterWashQueue['counts']) => number) =>
    state.kind === 'ok' ? n(state.counts) : '…';
  return (
    <div className="mb-4 grid grid-cols-2 gap-3">
      <Stat label={c.waiting} value={value((k) => k.waiting)} testId="cycle-waiting" />
      <Stat label={c.ready} value={value((k) => k.ready)} testId="cycle-ready" />
    </div>
  );
}
