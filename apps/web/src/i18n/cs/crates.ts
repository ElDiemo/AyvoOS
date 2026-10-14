/**
 * Czech strings of Výroba → Bedny (physical returnable crates, doc 025 A1). Codes (AYV-C-…,
 * CR-…, PJ-…) and crate type codes stay language-neutral.
 */
const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n >= 2 && n <= 4 ? few : many;

export const cratesWord = (n: number) => `${n} ${plural(n, 'bedna', 'bedny', 'beden')}`;
export const labelsWord = (n: number) => `${n} ${plural(n, 'štítek', 'štítky', 'štítků')}`;

export const cratesCs = {
  title: 'Bedny',
  subtitle:
    'Fyzické vratné bedny této provozovny a tisk jejich QR štítků. Typy beden (katalog) jsou v Produktech a recepturách.',
  count: (n: number, filtered: boolean) =>
    filtered ? `Nalezeno: ${cratesWord(n)}` : `Evidováno: ${cratesWord(n)}`,
  register: 'Evidovat nové bedny',
  search: 'Hledat kód bedny',
  searchPlaceholder: 'Kód bedny, např. AYV-C-000012 nebo 12',
  typeFilter: 'Typ bedny',
  allTypes: 'Všechny typy',
  filter: 'Filtrovat',
  reset: 'Zrušit filtr',
  none: 'Zatím není evidovaná žádná bedna.',
  noMatch: 'Žádná bedna neodpovídá filtru.',
  previous: 'Předchozí',
  next: 'Další',
  pageOf: (page: number, pages: number) => `Strana ${page} z ${pages}`,
  columns: {
    code: 'Kód',
    type: 'Typ a kapacita',
    circulation: 'Stav oběhu',
    location: 'Poslední evidované umístění',
    lastChange: 'Poslední změna',
  },
  capacity: (n: number) => `kapacita ${n}`,
  /** No open crate cycle: nothing recorded in the crate (doc 025 §3.2). */
  noCirculation: 'Prázdná – bez otevřeného oběhu',
  noCirculationHelp:
    'Obsah bedny se eviduje od lepení (sken lahve do bedny). Plnění a připravené bedny přidá navazující krok.',
  cycleStatus: {
    OPEN_ASSEMBLY: 'Skládá se (lepení)',
    READY_TO_FILL: 'Čeká na plnění',
    FILLING: 'Plní se',
    FILLED: 'Připravená',
    ABORTED: 'Zrušený oběh',
  } as Record<string, string>,
  cycleLine: (status: string, members: number, capacity: number, product: string) =>
    `${status} · obsah ${members}/${capacity} · ${product}`,
  notRecorded: 'Neevidováno',
  notRecordedHelp:
    'Umístění se zapisuje až skutečnou operací ve skladu. Registrace zaznamenává jen provozovnu.',
  site: 'Provozovna',
  registration: 'Registrace',
  registered: 'Zaevidováno',
  qrUrl: 'Adresa v QR kódu',
  qrUrlHelp: 'Stálá adresa bedny. Opakovaný tisk štítku vytiskne stejný QR kód.',
  history: 'Historie bedny',
  printJobs: 'Tiskové úlohy štítků',
  noPrintJobs: 'Štítek této bedny se zatím netiskl.',
  eventType: {
    REGISTERED: 'Bedna zaevidována',
    LABEL_PRINT_JOB_CREATED: 'Vytvořena tisková úloha QR štítku',
    CYCLE_OPENED: 'Začal oběh (první lahev vložena)',
    READY_TO_FILL: 'Bedna plná – čeká na plnění',
  } as Record<string, string>,
  eventBy: (actor: string) => `Provedl(a): ${actor}`,
  crateStatus: 'Stav bedny',
  status: {
    ACTIVE: 'V provozu',
    RETIRED: 'Vyřazená',
  } as Record<string, string>,
  backToList: 'Zpět na bedny',
  new: {
    title: 'Evidovat nové bedny',
    subtitle:
      'Každá bedna dostane trvalý kód AYV-C-… a vlastní QR kód. Kód bedny ani QR se později nemění.',
    type: 'Typ bedny',
    typeHelp: 'Typ určuje kapacitu. Bedna patří provozovně, ve které ji evidujete.',
    choose: 'Vyberte typ…',
    noTypes:
      'Není založen žádný typ bedny. Typ bedny založí správce katalogu v Produktech a recepturách.',
    quantity: 'Počet beden',
    quantityHelp: 'Kolik fyzických beden právě evidujete (1–1000).',
    quantityInvalid: 'Zadejte celé číslo od 1 do 1000.',
    typeRequired: 'Vyberte typ bedny.',
    submit: 'Zaevidovat bedny',
    saving: 'Ukládám…',
    done: (code: string, n: number) => `Registrace ${code}: zaevidováno ${cratesWord(n)}.`,
    codes: 'Kódy nových beden',
    another: 'Evidovat další bedny',
  },
  print: {
    title: 'Tisk QR štítků',
    reprintTitle: 'Tisk / opakovaný tisk QR štítku',
    help: 'Rozměr štítku ani tiskárna zatím nejsou schválené. Zadejte rozměr podle skutečného štítku a nejprve si otevřete náhled.',
    reprintHelp:
      'Opakovaný tisk vytvoří novou tiskovou úlohu se stejným QR kódem. Novou bednu nezakládá.',
    width: 'Šířka štítku (mm)',
    height: 'Výška štítku (mm)',
    sizeInvalid: 'Zadejte celé číslo od 20 do 300 mm.',
    qrSize: (mm: string) => `QR kód bude mít ${mm} mm včetně okraje.`,
    tooSmall: 'Na štítek této velikosti se čitelný QR kód nevejde. Zvětšete jej.',
    notApproved:
      'Čitelnost QR na tomto rozměru není fyzicky ověřená. Před ostrým použitím vytiskněte zkušební štítek a ověřte jej čtečkou.',
    preview: 'Otevřít náhled',
    previewHelp: 'Náhled má zástupný QR kód a označení PREVIEW, nic nezaznamenává.',
    submit: (n: number) => `Vytvořit PDF (${labelsWord(n)})`,
    working: 'Generuji PDF…',
    completed: (code: string) => `Tisková úloha ${code} je připravená.`,
    failed: (code: string) => `Generování ${code} selhalo. Zkuste to znovu.`,
    retry: 'Zkusit znovu',
    download: 'Stáhnout PDF',
    devLabels: 'DEV štítky – nesou označení DEV - NOT FOR PRODUCTION a vývojovou adresu.',
  },
  job: {
    size: (w: number, h: number) => `${w} × ${h} mm`,
    by: (name: string) => `vytvořil(a) ${name}`,
    failed: 'Generování PDF selhalo. Úlohu lze vygenerovat znovu se stejnými štítky.',
    running:
      'PDF se právě generuje. Obnovte stránku za chvíli; pokud generování uvázne, půjde po 10 minutách zopakovat.',
  },
  printJobStatus: {
    PENDING: 'Čeká na vygenerování',
    GENERATING: 'Generuje se',
    COMPLETED: 'Vygenerováno',
    FAILED: 'Generování selhalo',
  } as Record<string, string>,
  errors: {
    UNKNOWN_CRATE_TYPE: 'Tento typ bedny neexistuje. Obnovte stránku.',
    CRATE_NOT_FOUND: 'Některá z beden v této provozovně neexistuje.',
    LABEL_TOO_SMALL: 'Na štítek této velikosti se čitelný QR kód nevejde.',
    IDEMPOTENCY_CONFLICT: 'Požadavek se změnil během odesílání. Odešlete jej znovu.',
    FORBIDDEN: 'K této akci nemáte oprávnění.',
  } as Record<string, string>,
  invalidData: 'Údaje nejsou platné. Zkontrolujte je.',
  networkRetry:
    'Spojení se serverem selhalo. Výsledek není jistý – zkuste to znovu, opakování je bezpečné.',
  failed: 'Akci se nepodařilo dokončit. Zkuste to znovu.',
  fixErrors: (n: number) => (n === 1 ? 'Opravte 1 chybu.' : `Opravte chyby (${n}).`),
};
