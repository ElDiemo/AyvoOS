/**
 * "Zpět na přípravu výroby" (issue #11 UI-21): a target page reached from "Připravit výrobu"
 * returns to the same product. Only the setup page itself is accepted — nothing else is ever
 * followed from the query.
 */
const SETUP_RETURN = /^\/production\/setup(\?product=[A-Za-z0-9_-]{1,40})?$/;

export function setupReturn(value: unknown): string | null {
  return typeof value === 'string' && SETUP_RETURN.test(value) ? value : null;
}

export function setupReturnFor(productCode: string | null): string {
  return productCode ? `/production/setup?product=${productCode}` : '/production/setup';
}
