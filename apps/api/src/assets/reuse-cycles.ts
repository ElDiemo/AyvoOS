/**
 * Completed reuse cycles (ADR 0011): a cycle completes at the individual identification after a
 * return — the SORTED event. The database writes SORTED only for a bottle of a delivered cycle,
 * once per (bottle, cycle) (doc 047 §4.2), so each SORTED is one completed cycle; a delivery alone
 * writes no bottle event and completes nothing.
 */
export function countCompletedReuseCycles(eventTypesInOrder: readonly string[]): number {
  return eventTypesInOrder.filter((type) => type === 'SORTED').length;
}
