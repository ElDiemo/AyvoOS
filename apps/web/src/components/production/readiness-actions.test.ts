import type { ReadinessItem } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { readinessDependency, readinessStep } from './readiness-actions';
import type { ProductionReadiness } from '@ayvo/types';

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

describe('readinessDependency: "the recipe lacks this item" only for materials', () => {
  const item = (key: string, target: ReadinessItem['target']): ReadinessItem => ({
    key,
    state: 'MISSING',
    count: 0,
    href: null,
    reason: null,
    recipe: null,
    target,
  });
  const r = (items: ReadinessItem[]): ProductionReadiness => ({
    site: { code: 'CZ', name: 'Přerov' },
    products: [],
    product: null,
    setup: [],
    labeling: [],
    filling: items,
    crates: null,
  });

  it('a missing filling station never says the recipe lacks an item', () => {
    const station = item('filling.station', {
      item: null,
      designs: [],
      station: { mode: 'FILLING', categoryCode: 'HAND_SOAP' },
    });
    expect(readinessDependency(station, r([station]))).toBeNull();
    const labeling = item('labeling.station', {
      item: null,
      designs: [],
      station: { mode: 'LABELING', categoryCode: null },
    });
    expect(readinessDependency(labeling, r([labeling]))).toBeNull();
  });

  it('a material missing from the judged recipe says so', () => {
    for (const key of [
      'filling.liquid',
      'filling.pumps',
      'labeling.bottles',
      'labeling.labelStock',
    ]) {
      const missing = item(key, { item: null, designs: [], station: null });
      expect(readinessDependency(missing, r([missing])), key).toMatch(/receptura/);
    }
  });

  it('a material that is in the recipe but out of stock gets no recipe hint', () => {
    const liquid = item('filling.liquid', {
      item: { code: 'LIQ', name: 'Kapalina' },
      designs: [],
      station: null,
    });
    expect(readinessDependency(liquid, r([liquid]))).toBeNull();
    // Without stock access there is no target at all: nothing is claimed about the recipe.
    const hidden = { ...item('filling.liquid', null), state: 'UNAVAILABLE' as const, count: null };
    expect(readinessDependency(hidden, r([hidden]))).toBeNull();
  });
});
