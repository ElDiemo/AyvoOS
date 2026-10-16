import { labelingCs } from './labeling';

/**
 * Czech strings of the filling station and of the supervised crate corrections (doc 025 A4).
 * Codes stay language-neutral.
 */
export const fillingCs = {
  crate: {
    title: 'Bedna',
    scan: 'Naskenujte QR bedny z lepení',
    help: 'Plní se stejná bedna, do které se lahve vložily při lepení. Bedna musí být plná (čeká na plnění) nebo rozplněná.',
    loaded: (code: string, lotChosen: boolean) =>
      lotChosen
        ? `Bedna ${code} je načtená. Šarže kapaliny zůstává zvolená.`
        : `Bedna ${code} je načtená. Zvolte šarži kapaliny.`,
    content: 'Obsah',
    filled: 'Naplněno',
    recipe: (product: string, v: number) => `${product} · receptura verze ${v}`,
    change: 'Jiná bedna',
  },
  lot: {
    title: 'Šarže kapaliny',
    help: 'Zvolte šarži kapaliny, kterou skutečně plníte. Změna platí od další lahve; každá lahev má jednu šarži.',
    choose: 'Vyberte…',
    option: (code: string, onHand: string, unit: string) => `${code} (zbývá ${onHand} ${unit})`,
    apply: 'Použít šarži',
    change: 'Změnit šarži',
    current: (code: string, onHand: string, unit: string) =>
      `Šarže ${code}: zbývá ${onHand} ${unit}`,
    none: 'Ve skladu pracoviště není žádná šarže této kapaliny se zásobou.',
    perBottle: (q: string, unit: string, liquid: string, pump: string) =>
      `Na lahev: ${q} ${unit} ${liquid} + 1 ks ${pump}`,
    changed: (code: string) => `Šarže ${code} platí od další lahve.`,
  },
  scan: {
    label: 'Naskenujte lahev po naplnění a nasazení pumpičky',
    help: 'Scan potvrdí naplnění: ověří, že lahev patří do této bedny, a odepíše kapalinu a pumpičku. Opakovaný scan nic neodepíše.',
    filled: (bottle: string, n: number, cap: number) => `${bottle} naplněna (${n}/${cap}).`,
    already: (bottle: string) => `${bottle} už je naplněná – nic se neodepsalo.`,
  },
  finish: {
    button: 'Hotovo',
    help: 'Hotovo označí bednu jako připravenou. Jde jen u plné bedny, ve které jsou všechny lahve naplněné.',
    notYet: (members: number, filled: number, cap: number) =>
      `Hotovo zatím nejde: obsah ${members}/${cap}, naplněno ${filled}/${cap}.`,
    done: (code: string) => `Bedna ${code} je připravená. Naskenujte další bednu.`,
  },
  errors: {
    ...labelingCs.errors,
    WRONG_STATION_MODE: 'Toto není plnicí pracoviště.',
    MODE_NOT_PERMITTED: 'Na plnicím pracovišti nemáte oprávnění pracovat.',
    CONTEXT_INCOMPLETE: 'Nejprve načtěte bednu a zvolte šarži kapaliny.',
    CONTEXT_CHANGED:
      'Mezitím se změnila bedna nebo šarže. Scan se nezapsal – naskenujte lahev znovu.',
    CRATE_EMPTY: 'V bedně nejsou žádné nalepené lahve. Lahve se do bedny vkládají při lepení.',
    CRATE_NOT_READY: 'Bedna se ještě skládá na lepení. Plní se až plná bedna.',
    CRATE_ALREADY_FILLED: 'Bedna je už hotová (připravená).',
    WRONG_CATEGORY: 'V bedně je jiná kategorie produktu, než toto pracoviště plní.',
    NOT_IN_THIS_CRATE: 'Lahev není v žádné bedně. Odložte ji a řekněte vedoucímu.',
    IN_ANOTHER_CRATE: 'Lahev patří do jiné bedny – nic se nezapsalo. Vraťte ji do správné bedny.',
    BOTTLE_NOT_LABELED: 'Lahev ještě nemá nalepenou etiketu.',
    BOTTLE_NOT_BOUND:
      'Lahev byla nalepena dříve, než se evidovaly bedny, a nemá vazbu na produkt. Odložte ji stranou.',
    BOTTLE_NOT_FILLABLE: 'Tuto lahev nelze naplnit.',
    WRONG_LOT: 'Šarže nepatří ke kapalině této receptury.',
    LOT_EXHAUSTED: 'Zvolená šarže kapaliny už na lahev nestačí. Zvolte jinou šarži.',
    INSUFFICIENT_STOCK: 'Ve skladu chybí pumpičky. Nic se neodepsalo.',
    LOT_REQUIRED: 'Receptura vyžaduje šarži komponenty, kterou nelze zvolit.',
    RECIPE_INCOMPLETE: 'Receptura nemá kapalinu nebo pumpičku.',
    LIQUID_NOT_LOT_TRACKED:
      'Kapalina receptury se neeviduje po šaržích – lahev by neměla dohledatelnou šarži.',
    CRATE_NOT_COMPLETE: 'Hotovo zatím nejde: bedna není plná nebo nejsou naplněné všechny lahve.',
  } as Record<string, string>,
};

/** Supervised corrections of a crate (production:cycle_correct). */
export const crateCorrectionsCs = {
  title: 'Opravy vedoucího',
  help: 'Nejde o běžný pracovní krok: opravy dělá vedoucí s důvodem. Jen přesouvají lahve mezi bednami – nic se znovu neodepíše a hotová lahev nikdy nezmizí ani se nestane prázdnou.',
  bottle: 'Lahev (kód nebo naskenovaný QR)',
  reason: 'Důvod (povinný)',
  remove: 'Vyjmout lahev',
  add: 'Doplnit / přeložit lahev',
  reopen: 'Vrátit do rozpracování',
  abort: 'Zrušit oběh',
  abortTitle: 'Zrušit oběh bedny?',
  abortText:
    'Všechny lahve se z bedny vyjmou a zůstanou evidované mimo bednu se svým stavem. Nic se nevrátí do skladu ani neodepíše.',
  reopenTitle: 'Vrátit připravenou bednu do rozpracování?',
  reopenText: 'Bedna přestane být připravená, dokud ji plnicí pracoviště znovu neoznačí Hotovo.',
  done: {
    remove: (bottle: string) => `Lahev ${bottle} je vyjmutá z bedny.`,
    add: (bottle: string) => `Lahev ${bottle} je v bedně.`,
    reopen: 'Bedna je vrácená do rozpracování.',
    abort: 'Oběh je zrušený, lahve jsou mimo bednu.',
  },
  errors: {
    ...fillingCs.errors,
    CRATE_READY: 'Bedna je hotová. Nejprve ji vraťte do rozpracování.',
    CRATE_FULL: 'Bedna nemá volné místo.',
    SNAPSHOT_MISMATCH: 'Lahev má jiný produkt, design etikety nebo verzi receptury než bedna.',
    EMPTY_CRATE_TAKES_FINISHED:
      'Do prázdné bedny lze přeložit jen hotové lahve. Prázdnou lahev vložte do bedny, která se skládá se stejným produktem.',
    CRATE_TYPE_MISMATCH: 'Typ bedny neodpovídá receptuře lahve.',
    CRATE_NOT_READY: 'Vrátit lze jen připravenou bednu.',
    CRATE_EMPTY: 'Bedna nemá otevřený oběh.',
    NOT_IN_THIS_CRATE: 'Lahev v této bedně není.',
    NOT_FOUND: 'Lahev nebo bedna nebyla na této provozovně nalezena.',
  } as Record<string, string>,
};
