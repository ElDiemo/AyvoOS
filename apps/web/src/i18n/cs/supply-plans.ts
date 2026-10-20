/** Czech strings of the hotel supply plan (doc 032). Keys stay language-neutral. */
export const supplyPlansCs = {
  title: 'Plán zásobování',
  pageTitle: (hotel: string) => `Plán zásobování – ${hotel}`,
  intro:
    'Pravidelné dodávky hotelu: produkt, počet celých beden a dny v měsíci. Systém z plánu sám zakládá běžné objednávky do Expedice – nikdy sám nezaloží přepravu u dopravce, neobjedná svoz, nevytiskne štítky ani nic neodešle.',
  none: 'Hotel zatím nemá plán zásobování.',
  create: 'Vytvořit plán zásobování',
  edit: 'Upravit plán',
  open: 'Otevřít plán zásobování',
  status: {
    INACTIVE: 'Vypnutý',
    ACTIVE: 'Zapnutý',
    PAUSED: 'Pozastavený',
  } as Record<string, string>,
  statusHelp: {
    INACTIVE: 'Zatím nic nevytváří. Zapněte ho po kontrole náhledu.',
    ACTIVE: 'Objednávky na nejbližších 14 dní se zakládají automaticky.',
    PAUSED: 'Nové objednávky se nevytvářejí. Už vytvořené objednávky zůstávají beze změny.',
  } as Record<string, string>,
  version: (v: number) => `verze ${v}`,
  validity: (from: string, to: string | null) =>
    to ? `platí ${from} – ${to}` : `platí od ${from}`,
  next: 'Nejbližší termín',
  noNext: 'Žádný termín v příštím roce.',
  lastRunOk: 'Poslední úspěšné vyhodnocení',
  lastRun: 'Poslední pokus o vyhodnocení',
  neverRun: 'Zatím nevyhodnoceno.',
  lastRunError: (why: string) => `Poslední vyhodnocení se nepovedlo: ${why}`,
  blocked: 'Termíny, které nelze vytvořit',
  blockedLine: (date: string, why: string) => `${date}: ${why}`,
  technical: 'Technické podrobnosti',
  activatedBy: (by: string, at: string) => `Zapnul(a) ${by} · ${at}`,
  updatedBy: (by: string, at: string) => `Naposledy upravil(a) ${by} · ${at}`,
  rulesTitle: 'Pravidla',
  rule: (n: number) => `Pravidlo ${n}`,
  rulesLine: (crates: number, days: string) =>
    `${crates} ${crates === 1 ? 'bedna' : crates < 5 ? 'bedny' : 'beden'} · dny ${days}`,
  form: {
    validFrom: 'Platí od',
    validTo: 'Platí do (nepovinné)',
    validToHelp: 'Bez konce platí, dokud plán nepozastavíte.',
    product: 'Produkt',
    choose: 'Vyberte…',
    crates: 'Počet beden',
    days: 'Dny v měsíci',
    daysHelp:
      'Dny 29, 30 a 31 nejsou v každém měsíci. Když zvolený den v měsíci není, dodávka se ten měsíc neplánuje – termín se nikam neposouvá. Náhled to ukáže.',
    addRule: 'Přidat pravidlo',
    removeRule: 'Odebrat pravidlo',
    preview: 'Zobrazit náhled',
    save: 'Uložit plán',
    saveTitle: 'Uložit plán zásobování?',
    saveText:
      'Uloží se nová verze plánu. Už vytvořené objednávky se nemění ani neruší – změna platí jen pro termíny, pro které ještě objednávka nevznikla.',
    required: 'Vyplňte prosím.',
    cratesInvalid: 'Zadejte celý počet beden 1–999.',
    daysRequired: 'Zvolte alespoň jeden den.',
    validToBefore: 'Konec nesmí být před začátkem.',
    noProducts: 'Žádný aktivní produkt k objednání.',
  },
  existingOrdersWarning: (n: number) =>
    `Z plánu už vzniklo ${n} ${n === 1 ? 'objednávka' : n < 5 ? 'objednávky' : 'objednávek'}. Změna ani pozastavení plánu je nepřepíše ani nezruší – upravte je případně ručně.`,
  ordersTitle: 'Objednávky vytvořené z plánu',
  noOrders: 'Z plánu zatím nevznikla žádná objednávka.',
  moved: (planned: string) => `termín plánu ${planned}`,
  activate: 'Zapnout plán',
  activateTitle: 'Zapnout plán zásobování?',
  activateText:
    'Od zapnutí se budou automaticky zakládat běžné objednávky na nejbližších 14 dní podle náhledu níže. Přepravu, svoz, tisk štítků ani odeslání systém sám nikdy neudělá.',
  activateConfirm: 'Ano, zapnout plán',
  activateCheck: 'Zkontroloval(a) jsem náhled a chci plán zapnout.',
  pause: 'Pozastavit plán',
  pauseTitle: 'Pozastavit plán zásobování?',
  pauseText:
    'Nové objednávky se přestanou vytvářet. Už vytvořené objednávky zůstanou beze změny – jejich přehled je níže.',
  pauseConfirm: 'Pozastavit',
  resume: 'Znovu zapnout',
  preview: {
    title: 'Náhled příštích 30 dní',
    intro: (from: string, to: string, tz: string) =>
      `${from} – ${to} · dny podle časového pásma provozovny (${tz}). Náhled nic nezapisuje.`,
    whatTitle: 'Co se bude vytvářet',
    what: (orders: number) =>
      orders === 0
        ? 'V příštích 30 dnech nevznikne žádná nová objednávka.'
        : `V příštích 30 dnech ${orders === 1 ? 'vznikne 1 objednávka' : `vznikne ${orders} ${orders < 5 ? 'objednávky' : 'objednávek'}`}:`,
    whatLine: (product: string, crates: number, bottles: number | null) =>
      `${product}: ${crates} ${crates === 1 ? 'bedna' : crates < 5 ? 'bedny' : 'beden'}${bottles !== null ? ` (${bottles} lahví)` : ''}`,
    horizon: (days: number) =>
      `Objednávky se zakládají vždy nejvýše ${days} dní dopředu; vzdálenější termíny vzniknou později.`,
    blockedCount: (n: number) =>
      `${n} ${n === 1 ? 'termín má' : 'termíny mají'} překážku – nevznikne z nich žádná objednávka, dokud se překážka neodstraní.`,
    empty: 'V příštích 30 dnech plán nemá žádný termín.',
    shipDate: 'Odeslat dne',
    products: 'Produkty',
    crates: 'Bedny',
    bottles: 'Lahve',
    state: 'Stav',
    willCreate: 'Vznikne',
    later: 'Vznikne později',
    created: (order: string) => `Vytvořeno: ${order}`,
    blockedState: 'Překážka',
    overlap: (orders: string) => `Tento den už hotel má objednávku: ${orders}`,
    skipped: 'Dny, které v měsíci nejsou',
    skippedLine: (product: string, day: number, month: string) =>
      `${product}: ${day}. den v ${month} neexistuje – ten měsíc se nedodává`,
    unknownCapacity: 'neznámá kapacita',
  },
  blockers: {
    UNKNOWN_PRODUCT: (p: string | null) =>
      `Produkt ${p ?? ''} je neznámý nebo archivovaný.`.replace('  ', ' '),
    PRODUCT_WITHOUT_RECIPE: (p: string | null) =>
      `Produkt ${p ?? ''} nemá aktivní recepturu s typem bedny.`.replace('  ', ' '),
    SITE_WITHOUT_WAREHOUSE: () => 'Provozovna nemá sklad.',
    SITE_INACTIVE: () => 'Provozovna není aktivní.',
    HOTEL_OF_ANOTHER_SITE: () => 'Hotel obsluhuje jiná provozovna.',
  } as Record<string, (product: string | null) => string>,
  reasonLabel: 'Důvod změny',
};
