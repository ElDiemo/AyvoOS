import type { ReadinessItem } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { readinessStep } from './readiness-actions';

const labels: ReadinessItem = {
  key: 'labeling.labels',
  state: 'MISSING',
  count: 0,
  href: null,
  reason: null,
  recipe: null,
  target: {
    item: null,
    designs: [{ versionId: '0199a000-0000-7000-8000-000000000001', label: 'mydlo v1' }],
    station: null,
  },
};
const identities = ['production:read', 'production:bottles_create', 'catalog:read'];

describe('readinessStep: "Připravit QR etikety lahví (PDF)" (PR #30 UI30-R2)', () => {
  it('is not offered without production:labels_print — the PDF could not be generated', () => {
    expect(readinessStep(labels, identities, 'P-SOAP')).toEqual({ kind: 'ask', read: null });
  });

  it('is offered with every permission its target page needs, in the product context', () => {
    const step = readinessStep(labels, [...identities, 'production:labels_print'], 'P-SOAP');
    expect(step.kind).toBe('links');
    if (step.kind !== 'links') return;
    expect(step.links).toHaveLength(1);
    const url = new URL(step.links[0]!.href, 'https://dev.ayvo.co');
    expect(url.pathname).toBe('/bottles/new');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      product: 'P-SOAP',
      version: '0199a000-0000-7000-8000-000000000001',
      back: '/production/setup?product=P-SOAP',
    });
  });
});
