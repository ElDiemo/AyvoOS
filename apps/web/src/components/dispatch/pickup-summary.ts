import type { PickupView } from '@ayvo/types';
import { formatDateCs } from '@/i18n/cs/format';
import { pickupsCs as t } from '@/i18n/cs/pickups';

export type Tone = 'ok' | 'wait' | 'warn' | 'done';

/** A refusal with a clear next step in Czech; otherwise "the reason is in Podrobnosti". */
const instruction = (code: string | null) =>
  (code && t.instructions[code]) ?? t.instructionFallback;

/**
 * The first layer of one pickup (AYVO UX rule, docs/002): what happened, what it means for its
 * parcels and the one action that fits — the technical state stays in "Podrobnosti".
 */
export function pickupSummary(p: PickupView): {
  tone: Tone;
  title: string;
  hint: string;
  action: 'lookup' | 'cancel' | null;
} {
  const c = p.cancellation;
  if (p.cancelledByCarrierAt) {
    return { tone: 'done', title: t.state.cancelled, hint: t.hint.cancelled, action: null };
  }
  switch (p.status) {
    case 'PREPARED':
      return { tone: 'wait', title: t.state.waiting, hint: t.hint.processing, action: null };
    case 'ACCEPTED':
      return { tone: 'wait', title: t.state.waiting, hint: t.hint.processing, action: 'lookup' };
    case 'SENT':
      return { tone: 'wait', title: t.state.waiting, hint: t.hint.uncertain, action: 'lookup' };
    case 'REJECTED':
      return {
        tone: 'warn',
        title: t.state.rejected,
        hint: `${instruction(p.errorCode)} ${t.hint.released}`,
        action: null,
      };
    case 'NOT_CREATED':
      return { tone: 'done', title: t.state.notCreated, hint: t.hint.released, action: null };
    case 'NOT_SENT':
      return { tone: 'done', title: t.state.notSent, hint: instruction(p.errorCode), action: null };
    case 'CONFIRMED':
      break;
  }
  if (c && (c.status === 'PREPARED' || c.status === 'SENT' || c.status === 'ACCEPTED')) {
    return {
      tone: c.lookupsExhausted ? 'warn' : 'wait',
      title: t.state.cancelWaiting,
      hint: c.lookupsExhausted ? t.hint.cancelExhausted : t.hint.cancelLookingUp,
      action: 'lookup',
    };
  }
  const cancellable = !p.dayPassed;
  const confirmed = t.hint.confirmed(formatDateCs(p.date));
  if (c?.status === 'REJECTED') {
    return {
      tone: 'ok',
      title: t.state.confirmed,
      hint: `${t.hint.cancelRefused} ${instruction(c.errorCode)}`,
      action: cancellable ? 'cancel' : null,
    };
  }
  if (c?.status === 'NOT_CREATED') {
    return {
      tone: 'ok',
      title: t.state.confirmed,
      hint: t.hint.cancelClosed,
      action: cancellable ? 'cancel' : null,
    };
  }
  return {
    tone: 'ok',
    title: t.state.confirmed,
    hint: confirmed,
    // A confirmed pickup without the carrier's number yet is looked up first.
    action: !p.carrierOrderNumber ? 'lookup' : cancellable ? 'cancel' : null,
  };
}
