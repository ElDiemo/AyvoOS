/**
 * Completed reuse cycles (ADR 0011): a cycle completes at the first SORTED event (individual
 * identification after return) that follows a DELIVERED_TO_HOTEL event. v0.1 records only
 * CREATED events, so every bottle has 0 cycles; the rule is implemented now so the passport never
 * shows an invented number once delivery and sorting events exist.
 */
export function countCompletedReuseCycles(eventTypesInOrder: readonly string[]): number {
  let delivered = false;
  let cycles = 0;
  for (const type of eventTypesInOrder) {
    if (type === 'DELIVERED_TO_HOTEL') delivered = true;
    else if (type === 'SORTED' && delivered) {
      cycles += 1;
      delivered = false;
    }
  }
  return cycles;
}
