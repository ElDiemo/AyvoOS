import { describe, expect, it } from 'vitest';
import { createProspectRequestSchema, stageChangeNeedsReason } from './sales.js';

describe('sales stages (doc 034 §4)', () => {
  it('needs a reason only to go back or to reopen a result', () => {
    expect(stageChangeNeedsReason('NEW', 'CONTACTED')).toBe(false);
    expect(stageChangeNeedsReason('NEW', 'OFFER')).toBe(false);
    expect(stageChangeNeedsReason('OFFER', 'WON')).toBe(false);
    expect(stageChangeNeedsReason('NEGOTIATION', 'LOST')).toBe(false);
    expect(stageChangeNeedsReason('OFFER', 'CONTACTED')).toBe(true);
    expect(stageChangeNeedsReason('WON', 'OFFER')).toBe(true);
    expect(stageChangeNeedsReason('LOST', 'NEGOTIATION')).toBe(true);
    expect(stageChangeNeedsReason('LOST', 'WON')).toBe(true);
  });
});

describe('quick creation of a prospect', () => {
  const minimal = {
    requestId: crypto.randomUUID(),
    name: 'Penzion U Lípy',
    countryCode: 'AT',
    city: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    roomsEstimate: null,
    accommodationType: null,
    website: null,
    source: null,
    priority: null,
    note: null,
    ownerId: null,
    contact: null,
    acknowledgeDuplicates: false,
  };
  it('needs only a name and a country; unknown rooms stay null, never 0', () => {
    const parsed = createProspectRequestSchema.parse(minimal);
    expect(parsed.roomsEstimate).toBeNull();
    expect(createProspectRequestSchema.safeParse({ ...minimal, roomsEstimate: 0 }).success).toBe(
      false,
    );
  });
  it('takes a contact known only as "Recepce" with a foreign phone number', () => {
    const parsed = createProspectRequestSchema.parse({
      ...minimal,
      contact: {
        label: 'Recepce',
        position: null,
        email: '',
        phone: '+43 (0)662 123 456',
        note: null,
        isPrimary: true,
      },
    });
    expect(parsed.contact).toMatchObject({ label: 'Recepce', email: null });
  });
});
