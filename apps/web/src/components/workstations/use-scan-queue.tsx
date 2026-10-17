'use client';

import { useEffect, useRef, useState } from 'react';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { buttonClass } from '@/components/ui';
import { labelingCs } from '@/i18n/cs/labeling';

const t = labelingCs.scan;

/** One scan (or Hotovo) as made: its kind, the scanned value, the context revision, its id. */
export type QueueItem = { kind: string; raw: string; revision: number; requestId: string };

/**
 * A station's scanner series (issue #19 "rychlá série", doc 025 A3/A4): the scan field never
 * blocks; every scan is queued with the context revision it had when scanned and a stable request
 * id, and sent in order. An UNCERTAIN answer (`process` returns false: network, 5xx) stops the
 * queue: that item stays at its head with its request id until "Zkusit znovu" sends the SAME
 * attempt (the server replays a committed one, never consumes twice); later scans wait, visibly.
 * While anything waits or is uncertain the station reports `unresolved` (context, crate and
 * leaving are blocked by the caller; the leave guard of `ScanQueueStatus` stops navigation).
 */
export function useScanQueue(
  process: (item: QueueItem) => Promise<boolean>,
  onUnresolvedChange?: (unresolved: boolean) => void,
  /**
   * Keeps unresolved items (with their request ids) in this tab's sessionStorage, so a reload
   * restores them — stopped, as uncertain, until "Zkusit znovu" sends the SAME attempts.
   */
  storageKey?: string,
) {
  const queue = useRef<QueueItem[]>([]);
  const draining = useRef(false);
  const blockedRef = useRef(false);
  const processRef = useRef(process);
  const [waiting, setWaiting] = useState(0);
  const [blocked, setBlocked] = useState<QueueItem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    processRef.current = process;
  });
  const unresolved = waiting > 0 || blocked !== null;
  const save = () => {
    if (!storageKey) return;
    try {
      if (queue.current.length > 0) {
        sessionStorage.setItem(storageKey, JSON.stringify(queue.current));
      } else sessionStorage.removeItem(storageKey);
    } catch {
      // storage unavailable: the in-page queue and the leave guard still hold
    }
  };
  useEffect(() => {
    if (!storageKey) return;
    let stored: unknown = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    } catch {
      stored = null;
    }
    const items = Array.isArray(stored)
      ? stored.filter(
          (x): x is QueueItem =>
            typeof x === 'object' &&
            x !== null &&
            typeof x.kind === 'string' &&
            typeof x.raw === 'string' &&
            typeof x.revision === 'number' &&
            typeof x.requestId === 'string',
        )
      : [];
    if (items.length === 0) return;
    // Restored after a reload: the result of the first is unknown — stop until "Zkusit znovu".
    queue.current = items;
    blockedRef.current = true;
    // After hydration (the server rendered no queue): shown in the next microtask.
    void Promise.resolve().then(() => {
      setBlocked(items[0]!);
      setWaiting(items.length);
    });
  }, [storageKey]);
  useEffect(() => {
    onUnresolvedChange?.(unresolved);
  }, [unresolved, onUnresolvedChange]);

  async function drain() {
    draining.current = true;
    setBusy(true);
    try {
      while (queue.current.length > 0 && !blockedRef.current) {
        const item = queue.current[0]!;
        const definite = await processRef.current(item);
        if (!definite) {
          blockedRef.current = true;
          setBlocked(item);
          break;
        }
        queue.current.shift();
        save();
        setWaiting(queue.current.length);
      }
    } finally {
      draining.current = false;
      setBusy(false);
      setWaiting(queue.current.length);
    }
  }

  function enqueue(item: Omit<QueueItem, 'requestId'>) {
    if (item.raw.trim() === '' && item.kind !== 'finish') return;
    queue.current.push({ ...item, requestId: crypto.randomUUID() });
    save();
    setWaiting(queue.current.length);
    if (!draining.current && !blockedRef.current) void drain();
  }

  /** Retries the SAME uncertain item (same request id and context revision), then continues. */
  function retryBlocked() {
    blockedRef.current = false;
    setBlocked(null);
    if (!draining.current) void drain();
  }

  return { enqueue, retryBlocked, waiting, blocked, unresolved, busy };
}

/**
 * The visible state of an unresolved queue and the navigation guard while it lasts: nothing can
 * be discarded; "Zpět k vyřešení scanu" returns the focus to the scan field.
 */
export function ScanQueueStatus({
  queue,
  testIdPrefix,
  focusScan,
  texts = t,
}: {
  queue: ReturnType<typeof useScanQueue>;
  testIdPrefix: string;
  focusScan: () => void;
  /** The station's texts by default; other scan screens (picking) pass their own. */
  texts?: Pick<typeof t, 'leaveGuard' | 'blockedTitle' | 'blockedText' | 'waiting' | 'retry'>;
}) {
  const { unresolved, blocked, waiting, retryBlocked } = queue;
  return (
    <>
      <UnsavedChangesGuard dirty={unresolved} texts={texts.leaveGuard} onStay={focusScan} />
      {unresolved && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border-2 border-red-400 bg-red-50 p-3 text-sm text-red-950"
          data-testid={`${testIdPrefix}-unresolved`}
        >
          {blocked && (
            <>
              <p className="font-semibold">{texts.blockedTitle}</p>
              <p>{texts.blockedText}</p>
            </>
          )}
          <p data-testid={`${testIdPrefix}-waiting`}>
            {texts.waiting(Math.max(0, waiting - (blocked ? 1 : 0)))}
          </p>
          {blocked && (
            <button
              type="button"
              className={`${buttonClass.primary} self-start`}
              onClick={retryBlocked}
            >
              {texts.retry}
            </button>
          )}
        </div>
      )}
    </>
  );
}
