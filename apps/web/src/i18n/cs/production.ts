/**
 * Czech strings of the Production module (doc 019): bottle identities and series, label
 * templates, label print jobs and the physical label application. Codes (AYV-B-…, BC-…, PJ-…),
 * template names and state values from the API stay language-neutral; their names are mapped here.
 */
const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n >= 2 && n <= 4 ? few : many;

export const bottlesWord = (n: number) => `${n} ${plural(n, 'lahev', 'lahve', 'lahví')}`;

export const productionCs = {
  bottleStatus: {
    CREATED: 'Vytvořená identita',
    LABELED_EMPTY: 'Etiketa nalepena – prázdná lahev',
  } as Record<string, string>,
  eventType: {
    CREATED: 'Identita vytvořena',
    LABEL_APPLIED: 'Etiketa nalepena na lahev',
    ASSIGNED_TO_CRATE: 'Vložena do bedny',
  } as Record<string, string>,
  printJobStatus: {
    PENDING: 'Čeká na vygenerování',
    GENERATING: 'Generuje se',
    COMPLETED: 'Vygenerováno',
    FAILED: 'Generování selhalo',
  } as Record<string, string>,
  common: {
    networkError:
      'Spojení se serverem selhalo. Výsledek není jistý – zkuste to znovu, opakování je bezpečné.',
    unexpectedError: 'Akci se nepodařilo dokončit. Zkuste to znovu nebo kontaktujte vedoucího.',
    failed: (reason: string) => `Akce se nezdařila: ${reason}`,
    back: 'Zpět',
    devLabels: 'DEV etikety – ne pro skutečné lahve',
    devLabelsHint: 'Etikety nesou označení DEV - NOT FOR PRODUCTION a vývojové adresy',
  },
  overview: {
    title: 'Přehled výroby',
    subtitle:
      'Identity lahví a jejich série, tisk etiket, šablony etiket a fyzické nalepení etiket na lahve.',
    bottles: 'Identity lahví',
    awaitingLabel: 'Čeká na nalepení etikety',
    labeled: 'S nalepenou etiketou',
    series: 'Série lahví',
    templates: 'Aktivní šablony etiket',
    recentSeries: 'Poslední série',
    noSeries: 'Zatím nebyla vytvořena žádná série lahví.',
    recentApplications: 'Poslední nalepené etikety',
    noApplications: 'Zatím nebyla nalepena žádná etiketa.',
    capabilities: 'Činnosti výroby',
    capability: {
      bottles: 'Identity lahví, jejich stav a historie vytvoření sérií.',
      templates: 'Grafika etiket a umístění QR kódu. Každá změna je nová neměnná verze.',
      printJobs: 'Tisková PDF etiket se vytvářejí u každé série lahví.',
      labelActivation:
        'Na lepicím pracovišti: po nalepení etikety sken vloží lahev do bedny a odečte tělo lahve a etiketu.',
    },
    printJobsLink: 'Tisk etiket v historii sérií',
  },
  bottles: {
    title: 'Lahve',
    views: 'Zobrazení lahví',
    list: 'Všechny lahve',
    history: 'Historie vytvoření',
    count: (n: number, filtered: boolean) =>
      `${bottlesWord(n)}${filtered ? ' odpovídá filtru' : ''}`,
    historyCount: (n: number) =>
      `${n} ${plural(n, 'série', 'série', 'sérií')} · každá série uchovává své lahve, šablonu etiket a tiskové úlohy`,
    search: 'Hledat podle kódu lahve',
    searchPlaceholder: 'Kód lahve, např. AYV-B-000001 nebo 1',
    seriesFilter: 'Filtrovat podle série',
    seriesPlaceholder: 'Série, např. BC-000001',
    templateFilter: 'Filtrovat podle šablony etiket',
    allTemplates: 'Všechny šablony',
    statusFilter: 'Filtrovat podle stavu',
    allStatuses: 'Všechny stavy',
    filter: 'Filtrovat',
    reset: 'Zrušit filtr',
    noMatch: 'Filtru neodpovídá žádná lahev.',
    none: 'Zatím nejsou žádné lahve.',
    noneHistory: 'Zatím nebyly vytvořeny žádné lahve.',
    create: 'Vytvořit lahve',
    code: 'Kód lahve',
    status: 'Stav',
    series: 'Série',
    template: 'Šablona etiket',
    createdAt: 'Vytvořeno',
    bottlesColumn: 'Lahve',
    labelsColumn: 'Etikety',
    actions: 'Akce',
    noPrintJob: 'Bez tiskové úlohy',
    downloadPdf: 'Stáhnout PDF',
    details: 'Detail',
    labelsAndDetails: 'Etikety a detail',
    // Series record no author (no column, no audit event); history is never guessed (issue #11).
    noCreator: 'Autor vytvoření série se v AYVO OS neeviduje.',
  },
  bottle: {
    subtitle: 'Vratná lahev AYVO',
    back: 'Lahve',
    overview: 'Základní údaje',
    status: 'Stav',
    reuseCycles: 'Dokončené cykly použití',
    createdAt: 'Vytvořeno',
    label: 'Etiketa',
    series: 'Vytvořena v sérii',
    physical: 'Fyzická lahev',
    labelApplied: 'Etiketa nalepena',
    bodyFromLot: 'Tělo lahve ze šarže',
    receipt: 'Příjem zboží',
    receiptLine: (n: number) => `řádek ${n}`,
    notApplied:
      'Pouze identita a etiketa – vytištěná etiketa zatím nebyla nalepena na fyzickou lahev.',
    components: 'Historie komponent',
    componentType: { LABEL: 'Etiketa' } as Record<string, string>,
    installed: (when: string) => `nainstalováno ${when}`,
    removed: (when: string) => `odebráno ${when}`,
    installedNow: 'aktuálně nainstalováno',
    lifecycle: 'Životní cyklus',
    qr: 'QR kód',
    qrTitle: (code: string) => `QR kód lahve ${code}`,
    openPassport: 'Otevřít pas lahve',
    qrHelp: 'QR kód obsahuje pouze tuto stálou veřejnou adresu:',
  },
  series: {
    subtitle: (n: number) => `Vytvořená série: ${bottlesWord(n)}`,
    back: 'Lahve · Historie vytvoření',
    viewBottles: 'Zobrazit lahve série',
    summary: 'Souhrn',
    bottles: 'Lahve',
    template: 'Šablona etiket',
    range: 'Rozsah kódů',
    createdAt: 'Vytvořeno',
    labels: 'Etikety',
    createPrintJob: 'Vytvořit tiskovou úlohu',
    reprint: 'Nová tisková úloha (dotisk)',
    noPrintJob: 'Zatím žádná tisková úloha.',
    footnote: (n: number, template: string) =>
      `Každá tisková úloha vykreslí přesně těchto ${bottlesWord(n)} se šablonou ${template}. Tisk nikdy nevytváří ani neodstraňuje lahve.`,
  },
  printJob: {
    labels: (n: number, template: string) =>
      `${n} ${plural(n, 'etiketa', 'etikety', 'etiket')} · ${template}`,
    generate: 'Vygenerovat etikety',
    retry: 'Generovat znovu',
    generating: 'Generuji…',
    download: (size: string) => `Stáhnout PDF${size ? ` (${size})` : ''}`,
    creating: 'Vytvářím…',
    details: (p: {
      created: string;
      completed: string | null;
      attempts: number;
      level: string;
      template: string;
    }) =>
      [
        `Vytvořeno ${p.created}`,
        p.completed ? `dokončeno ${p.completed}` : null,
        p.attempts > 1 ? `${p.attempts} pokusů` : null,
        `oprava chyb QR ${p.level}`,
        `jedna etiketa na stránku ve velikosti ${p.template}`,
        'tiskněte ve 100 %, bez změny měřítka',
      ]
        .filter(Boolean)
        .join(' · '),
  },
  create: {
    title: 'Vytvořit lahve',
    subtitle: 'Každá nová lahev dostane trvalý kód a QR kód; její etikety se připraví k tisku.',
    back: 'Lahve',
    quantity: '1 · Počet lahví',
    quantityInvalid: (min: number, max: number) => `Zadejte celé číslo od ${min} do ${max}.`,
    template: '2 · Šablona etiket',
    templateHelp: 'Nejnovější verze každé aktivní šablony.',
    review: 'Zkontrolovat',
    reviewTitle: '3 · Kontrola',
    confirmation: (n: number, template: string) =>
      `Chystáte se vytvořit ${bottlesWord(n)} s trvalou identitou AYVO a šablonou etiket ${template}.`,
    bottles: 'Lahve',
    expectedCodes: 'Očekávané kódy',
    finalCodes: 'Konečné kódy se potvrdí po vytvoření.',
    qrCodes: 'QR kódy',
    devNotice: 'Vývojové prostředí – každá etiketa nese označení „DEV - NOT FOR PRODUCTION“.',
    acknowledge: 'Rozumím, že identity lahví jsou trvalé a nikdy se nemažou.',
    submit: (n: number) => `Vytvořit ${bottlesWord(n)}`,
    creating: 'Vytvářím…',
    back2: 'Zpět',
    uncertain: (reason: string) =>
      `${reason}. Lahve možná byly, možná nebyly vytvořeny. Opakované stisknutí tlačítka je bezpečné: toto potvrzení nikdy nevytvoří lahve dvakrát.`,
    requestFailed: 'Požadavek se nezdařil',
    success: (n: number) => `${bottlesWord(n)} – úspěšně vytvořeno`,
    replayed: 'Toto vytvoření už bylo dokončeno dříve – žádné další lahve nebyly vytvořeny.',
    created: 'Vytvořeno lahví',
    codes: 'Kódy lahví',
    series: 'Série',
    viewCreated: 'Zobrazit vytvořené lahve',
    seriesDetails: 'Detail série',
    another: 'Vytvořit další',
    labels: 'Etikety',
    printJobMissing:
      'Lahve byly vytvořeny, ale jejich tiskovou úlohu se nepodařilo připravit. Lahve jsou v pořádku – tiskovou úlohu vytvořte nyní nebo později v detailu série.',
    unfinished: (n: number) =>
      `Potvrzené vytvoření ${bottlesWord(n)} nezobrazilo výsledek (například po obnovení stránky). Dokončení je bezpečné: pokud lahve už vznikly, zobrazí se jejich výsledek a žádné nové lahve nevzniknou.`,
    finish: 'Dokončit a zobrazit výsledek',
    checking: 'Ověřuji…',
    discard: 'Zahodit',
    discardHelp:
      'Zahozením se zapomene pouze toto potvrzení. Lahve, které už vznikly, zůstávají v historii vytvoření.',
    needTemplate: 'Lahve se vytvářejí se šablonou etiket.',
    createTemplate: 'Nejprve vytvořte šablonu etiket',
  },
  templates: {
    title: 'Šablony etiket',
    subtitle: 'Opakovaně použitelné návrhy etiket. Každá uložená změna je nová neměnná verze.',
    qrSheet: 'Kontrolní arch QR (PDF)',
    create: 'Nová šablona',
    empty: 'Zatím nejsou žádné šablony etiket. Vytvořte první, např. „mydlo1“.',
    archived: 'archivováno',
    current: 'aktuální',
    summary: (version: number, size: string, count: number) =>
      `Aktuální: v${version} · ${size} · ${count} ${plural(count, 'verze', 'verze', 'verzí')}`,
    detailSubtitle: (count: number) =>
      `Šablona etiket · ${count} ${plural(count, 'verze', 'verze', 'verzí')}`,
    back: 'Šablony etiket',
    edit: 'Upravit (nová verze)',
    createBottles: 'Vytvořit lahve s touto šablonou',
    saved: (name: string, version: string) => `Uloženo jako ${name} v${version}.`,
    archivedNotice: (when: string) =>
      `Archivováno ${when}: zůstává pro reprodukci dřívějších etiket, pro nové lahve ji nelze vybrat.`,
    labelSize: 'Velikost etikety',
    artwork: 'Grafika',
    qrCode: 'QR kód',
    savedAt: 'Uloženo',
    calibration: 'Kalibrační PDF (tiskněte ve 100 %)',
    immutable: 'Verze jsou neměnné: etikety vytištěné s touto verzí lze vždy reprodukovat.',
    qrPosition: 'Umístění QR kódu',
    archive: 'Archivovat šablonu',
    restore: 'Obnovit šablonu',
    archiveConfirm: 'Archivovat tuto šablonu? Pro nové lahve ji pak nelze použít.',
    newTitle: 'Nová šablona etiket',
    newSubtitle: 'Nahrajte grafiku, nastavte tištěnou velikost a umístěte QR kód.',
    editTitle: (name: string) => `Upravit ${name}`,
    editSubtitle: (label: string) =>
      `Vychází z ${label}. Vyměňte grafiku, změňte velikost nebo posuňte QR kód.`,
  },
  editor: {
    stepTemplate: '1 · Šablona',
    stepArtwork: '1 · Grafika',
    name: 'Název šablony',
    nameHelp: 'Malá písmena, číslice, „-“ a „_“. Později jej nelze změnit.',
    newVersion: (name: string, version: number) =>
      `Uložením vznikne ${name} v${version}. Dosavadní verze – a všechny etikety s nimi vytištěné – zůstávají beze změny.`,
    stepSize: '2 · Fyzická velikost etikety',
    stepQr: '3 · Umístění QR kódu',
    saveFirst: 'Uložit šablonu (v1)',
    // The template name is shown above; a long name must not widen the button on a phone.
    saveVersion: (version: number) => `Uložit novou verzi (v${version})`,
    saving: 'Ukládám…',
    unchanged: (label: string) => `Beze změn – ${label} zůstává stejná.`,
    artworkLabel: 'Grafika na pozadí (SVG, PNG nebo JPEG)',
    artworkTooLarge: (max: string) => `Soubor je příliš velký (nejvýše ${max})`,
    artworkHelp: (max: string) => `Nejvýše ${max}. SVG zůstane v tisku vektorově ostré.`,
    uploading: ' · Nahrávám…',
    width: 'Šířka',
    height: 'Výška',
    keepProportions: 'Zachovat proporce grafiky',
    sizeFromSvg: 'Velikost převzata ze souboru SVG. ',
    checkSize: 'Zkontrolujte tištěnou velikost etikety. ',
    rasterSize:
      'Rastrové soubory neuvádějí spolehlivou fyzickou velikost: zadejte tištěnou velikost etikety. ',
    fillsLabel: 'Grafika vyplní celou etiketu (bez spadávky ve v0.1).',
    proportionMismatch: (percent: number) =>
      `Velikost etikety neodpovídá proporcím grafiky (rozdíl přes ${percent} %) – grafika by se zdeformovala. Server takové rozvržení odmítne.`,
    qrPosition: 'Pozice QR kódu (od levého horního rohu)',
    qrSquare: 'QR kód je čtvercový',
    qrBoxLabel: (x: number, y: number, size: number) =>
      `QR kód na ${x} mm, ${y} mm, šířka ${size} mm. Posun šipkami.`,
    qrPreview: 'Náhled QR kódu',
    artworkAlt: 'Grafika etikety',
    stageHelp: (w: number, h: number) =>
      `${w} × ${h} mm · QR kód posunete tažením, velikost změníte tažením rohu. Přerušovaná čára je hranice QR kódu včetně bílého okraje.`,
    minSize: (mm: number) =>
      `Nejmenší velikost QR kódu: ${mm} mm (včetně bílého okraje). Šipky posouvají o 0,1 mm, se Shiftem o 1 mm.`,
  },
  labelActivation: {
    title: 'Nalepení etiket',
    subtitle:
      'Nalepte vytištěnou QR etiketu na novou lahev a lahev naskenujte. Každá úspěšná aktivace odečte jednu novou lahev ze zvolené skladové šarže.',
    setupTitle: 'Příprava pracovní směny',
    setupHelp:
      'Sérii lahví a zdrojovou šarži vyberete jednou pro celou směnu. Systém je nikdy sám nemění.',
    seriesStep: '1 · Série lahví (tisková série etiket)',
    seriesHelp:
      'Server přijme pouze lahve této série – etikety jiných sérií se při skenování odmítnou.',
    noSeries:
      'Žádná série nemá vygenerované etikety. Nejprve vytvořte lahve a vygenerujte jejich etikety.',
    seriesOption: (template: string, range: string) => `${template} · ${range}`,
    lotStep: '2 · Zdrojová šarže nových lahví (sklad)',
    lotHelp: 'Po vyčerpání šarže musíte vybrat další – systém šarži nikdy nezmění sám.',
    noLots: 'Na skladě nejsou žádné nové lahve. Nejprve zaevidujte příjem zboží.',
    lotCodePlaceholder: 'nebo zadejte kód šarže',
    useLot: 'Použít šarži',
    unknownLot: 'Šarže s tímto kódem nemá žádné nové lahve.',
    ambiguousLot: 'Tento kód má více šarží (různí dodavatelé). Vyberte šarži ze seznamu.',
    series: 'Série lahví',
    lot: 'Zdrojová šarže',
    remaining: (n: string) => `zbývá ${n} ks`,
    change: 'Změnit',
    changeSeries: 'Změnit sérii',
    changeLot: 'Změnit šarži',
    scanLabel: 'Naskenujte QR etiketu lahve',
    scanPlaceholder: 'Naskenujte nebo vložte celou adresu z QR kódu a stiskněte Enter',
    submit: 'Aktivovat',
    checking: 'Ověřuji…',
    ready: 'Připraveno ke skenování',
    applied: (code: string) => `${code} – etiketa nalepena`,
    appliedDetail: (lot: string, left: string) =>
      `Odečtena 1 nová lahev ze šarže ${lot}. Zbývá ${left} ks.`,
    alreadyApplied: (code: string) => `${code} – etiketa už byla nalepena`,
    alreadyAppliedDetail: (when: string) =>
      `Aktivováno ${when}. Žádná další lahev nebyla odečtena.`,
    lotExhaustedTitle: 'Šarže je vyčerpaná',
    lotExhausted: 'Ve zvolené šarži už nejsou žádné nové lahve. Vyberte další šarži.',
    sessionResults: 'Výsledky této směny',
    sessionHelp: 'Pouze v tomto okně prohlížeče.',
    noResults: 'Zatím nic nenaskenováno.',
    recentElsewhere: 'Naposledy aktivováno',
    errors: {
      NOT_AYVO_QR: {
        title: 'Toto není etiketa AYVO',
        action: 'Zkontrolujte, že skenujete QR kód na etiketě lahve.',
      },
      WRONG_ENVIRONMENT: {
        title: 'Etiketa patří do jiného prostředí',
        action: 'Tuto etiketu zde nepoužívejte. Lahev odložte a informujte vedoucího výroby.',
      },
      UNKNOWN_LABEL: {
        title: 'Neznámá etiketa',
        action: 'Lahev odložte a informujte vedoucího výroby.',
      },
      WRONG_SERIES: {
        title: 'Lahev nepatří do zvolené série',
        action:
          'Etiketa je z jiné tiskové série. Lahev odložte a zkontrolujte, které etikety máte u linky.',
      },
      BOTTLE_OF_ANOTHER_SITE: {
        title: 'Lahev patří jiné provozovně',
        action:
          'Lahve se mezi provozovnami nepřevádějí. Lahev odložte a informujte vedoucího výroby.',
      },
      LABEL_NOT_PRINTED: {
        title: 'Etiketa nebyla vytištěna systémem AYVO OS',
        action: 'Lahev odložte a informujte vedoucího výroby.',
      },
      NOT_APPLICABLE: {
        title: 'Tuto lahev nelze aktivovat',
        action: 'Lahev je v jiném stavu. Informujte vedoucího výroby.',
      },
      WRONG_LOT: {
        title: 'Neplatná šarže',
        action: 'Vyberte šarži nových lahví znovu.',
      },
      IDEMPOTENCY_CONFLICT: {
        title: 'Požadavek se nepodařilo zpracovat',
        action: 'Naskenujte lahev znovu.',
      },
    } as Record<string, { title: string; action: string }>,
  },
};
