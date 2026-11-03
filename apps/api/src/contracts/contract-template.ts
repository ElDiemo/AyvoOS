import type { ContractDraftFields } from '@ayvo/types';

/**
 * The Czech B2B working template `cs-b2b-1` (ADR 0043 §5, doc 045 §6). A WORKING TEXT for legal
 * review, never an approved legal model: every page is marked "NÁVRH – K PRÁVNÍ KONTROLE", and
 * whatever the owner has not decided is a marked gap "[… doplní právní kontrola]" — no moment of
 * transfer, loan, equipment price, liability or other binding term is invented. The entered values
 * are printed exactly; nothing is computed. A new wording is a new version (cs-b2b-2), never an edit
 * of this one: saved revisions name the version they were made with.
 */
export const DRAFT_MARK = 'NÁVRH – K PRÁVNÍ KONTROLE';
const GAP = (what: string) => `[${what} – doplní právní kontrola]`;
const BLANK = '…………………………………………';

export interface ContractDocument {
  title: string;
  /** Lines under the title: code, revision, template, date. */
  meta: string[];
  notice: string;
  sections: { heading: string; paragraphs: string[] }[];
  signatures: string[];
}

export interface TemplateInput {
  code: string;
  revision: number;
  /** "YYYY-MM-DD", the day the revision was saved (not the download day: same revision, same PDF). */
  savedOn: string;
  fields: ContractDraftFields;
}

/** "2026-11-03" → "3. 11. 2026" */
export const czDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
};
/** "1500.5" → "1 500,50" (the exact decimal, only regrouped; never a float). */
export const czAmount = (amount: string) => {
  const [whole, fraction = ''] = amount.split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${fraction.padEnd(2, '0')}`;
};

const TIMING: Record<ContractDraftFields['billingTiming'], string> = {
  ADVANCE: 'předem',
  ARREARS: 'zpětně',
};

/** The holders paragraph of each variant — working text, marked for legal review. */
export function holdersText(
  f: Pick<ContractDraftFields, 'holders' | 'holdersOwnership'>,
): string[] {
  const work = '[pracovní text k právní kontrole]';
  if (f.holders === 'NONE') return [`${work} Součástí služby nejsou držáky.`];
  if (f.holdersOwnership === 'AYVO')
    return [
      `${work} Součástí služby jsou držáky. Držáky zůstávají ve vlastnictví AYVO.`,
      GAP('Podmínky užívání, předání, vrácení a odpovědnosti za držáky'),
    ];
  return [
    `${work} Součástí služby jsou držáky. Držáky přejdou do vlastnictví zákazníka.`,
    GAP('Okamžik a podmínky převodu vlastnictví, cena držáků a odpovědnost'),
  ];
}

export function contractDocument(input: TemplateInput): ContractDocument {
  const f = input.fields;
  const representative = f.representativeName
    ? `${f.representativeName}${f.representativeRole ? `, ${f.representativeRole}` : ''}`
    : BLANK;
  return {
    title: 'Smlouva o poskytování služby AYVO',
    meta: [
      `${input.code} · revize ${input.revision} · šablona cs-b2b-1`,
      `Revize uložena ${czDate(input.savedOn)}`,
    ],
    notice:
      'Pracovní návrh připravený v AYVO OS. Není to schválený právní vzor ani uzavřená smlouva. ' +
      'Znění a chybějící ujednání doplní a schválí právní kontrola.',
    sections: [
      {
        heading: '1. Smluvní strany',
        paragraphs: [
          `Dodavatel: ${GAP('identifikace dodavatele')}`,
          `Odběratel: ${f.counterpartyName}`,
          `IČO: ${f.counterpartyCompanyId ?? BLANK}`,
          `Sídlo: ${f.counterpartyAddress ?? BLANK}`,
          `Zastoupen: ${representative}`,
        ],
      },
      {
        heading: '2. Předmět',
        paragraphs: [
          `Služba AYVO pro hotel ${f.hotelName}, ${f.hotelAddress}.`,
          GAP('Přesný rozsah služby'),
        ],
      },
      {
        heading: '3. Cena a fakturace',
        paragraphs: [
          `Počet pokojů: ${f.rooms}`,
          `Cena za pokoj a měsíc bez DPH: ${czAmount(f.pricePerRoomMonth)} ${f.currency}`,
          `Začátek: ${czDate(f.startOn)}`,
          `Fakturace: ${TIMING[f.billingTiming]}`,
          `Splatnost: ${f.paymentTermsDays} dní`,
          'Ceny jsou uvedeny bez DPH.',
        ],
      },
      { heading: '4. Držáky', paragraphs: holdersText(f) },
      {
        heading: '5. Ostatní ujednání',
        paragraphs: [GAP('Doba trvání, ukončení a další ujednání')],
      },
    ],
    signatures: [
      `Za dodavatele: ${BLANK}   Datum: ……………`,
      `Za odběratele: ${BLANK}   Datum: ……………`,
    ],
  };
}
