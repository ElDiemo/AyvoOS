import { describe, expect, it } from 'vitest';
import {
  createRecipeDraftRequestSchema,
  materialRequirementsQuerySchema,
  productCodeSchema,
  RECIPE_STAGE_OF_KIND,
  REQUIRED_RECIPE_KINDS,
} from './catalog.js';

const requestId = '01990000-0000-7000-8000-000000000001';

describe('catalogue contracts (doc 023)', () => {
  it('a draft carries either its content or the version it copies — never both', () => {
    const content = { requestId, reason: 'návrh', crateTypeCode: null, components: [] };
    expect(createRecipeDraftRequestSchema.safeParse(content).success).toBe(true);
    const copy = { requestId, reason: 'nová verze', basedOnVersion: 1 };
    expect(createRecipeDraftRequestSchema.safeParse(copy).success).toBe(true);
    expect(
      createRecipeDraftRequestSchema.safeParse({ ...content, basedOnVersion: 1 }).success,
    ).toBe(false);
    expect(createRecipeDraftRequestSchema.safeParse({ ...copy, reason: ' ' }).success).toBe(false);
  });

  it('quantities are positive decimal strings, never numbers', () => {
    const line = (quantity: unknown) =>
      createRecipeDraftRequestSchema.safeParse({
        requestId,
        reason: 'návrh',
        crateTypeCode: null,
        components: [{ itemCode: 'LIQUID', quantity, unitCode: 'ml' }],
      }).success;
    expect(line('330')).toBe(true);
    expect(line('330.5')).toBe(true);
    for (const bad of [330, '0', '-1', '1e3', '330.0001', ''])
      expect(line(bad), String(bad)).toBe(false);
  });

  it('product codes fit the recipe BOM codes; bottles are 1…1 000 000', () => {
    expect(productCodeSchema.safeParse('SOAP-330').success).toBe(true);
    expect(productCodeSchema.safeParse('A'.repeat(25)).success).toBe(false);
    expect(materialRequirementsQuerySchema.parse({ bottles: '41' })).toEqual({ bottles: 41 });
    for (const bad of ['0', '1.5', '1000001', 'x'])
      expect(materialRequirementsQuerySchema.safeParse({ bottles: bad }).success, bad).toBe(false);
  });

  it('every required kind has its stage', () => {
    expect(REQUIRED_RECIPE_KINDS.map((k) => RECIPE_STAGE_OF_KIND[k])).toEqual([
      'LABEL_APPLICATION',
      'LABEL_APPLICATION',
      'FILL',
      'FILL',
    ]);
  });
});
