/**
 * Czech strings of Výroba → Oběh lahví: the return intake (Příjem vratek, doc 047 §4.9) and Po mytí. Codes and states stay
 * language-neutral; every visible text is here.
 */
export const returnsCs = {
  /** Výroba → Oběh lahví (owner 2026-11-09): where to scan a return, confirm washing, go on. */
  cycle: {
    title: 'Oběh lahví',
    subtitle:
      'Vrácené lahve aktivní provozovny: nejdřív příjem vratek, po fyzickém umytí a kontrole druhý sken.',
    views: 'Části oběhu lahví',
    view: { overview: 'Přehled', returns: 'Příjem vratek', afterWash: 'Po mytí' },
    site: (name: string) => `Provozovna: ${name}`,
    step: (n: number) => `Krok ${n}`,
    returns: {
      text: 'Tady pípnete vrácenou bednu (tím se uvolní) a každou vrácenou lahev zvlášť – v libovolném pořadí.',
      open: 'Přijmout vratku',
    },
    afterWash: {
      text: 'Tady jedním skenem potvrzujete umytou a zkontrolovanou lahev.',
      open: 'Potvrdit po mytí',
      waiting: 'Čekají na mytí',
      ready: 'Připravené k plnění · Po mytí',
      countsUnavailable: 'Počty Po mytí jsou teď nedostupné. Obě akce fungují dál.',
    },
    station: {
      title: 'Pracoviště',
      text: 'Lepení etiket a plnění do beden probíhá na pracovišti.',
      open: 'Pracovat na pracovišti',
    },
    next: 'Pokračovat: Po mytí',
  },
  title: 'Příjem vratek',
  subtitle:
    'Sken vrácené bedny ji hned uvolní pro další použití. Každá lahev se přijímá jen vlastním skenem – nezávisle na bedně. Nic se nepočítá ručně.',
  open: {
    title: 'Nový příjem',
    hotel: 'Hotel (nepovinné)',
    noHotel: '— neuveden —',
    submit: 'Otevřít příjem',
  },
  list: {
    title: 'Příjmy vratek',
    empty: 'Zatím žádný příjem vratek.',
    code: 'Příjem',
    state: 'Stav',
    hotel: 'Hotel',
    opened: 'Otevřen',
    lines: 'Řádky',
    identified: 'Identifikováno',
    openIssues: 'Otevřené neshody',
  },
  state: { OPEN: 'Otevřený', CLOSED: 'Uzavřený' } as Record<string, string>,
  overview: {
    waiting: 'Vrácené, čekají na mytí',
    waitingEmpty: 'Žádná lahev nečeká na mytí.',
    since: 'od',
    issues: 'Otevřené neshody',
    issuesEmpty: 'Žádná otevřená neshoda.',
    resolve: 'Dořešit',
  },
  receipt: {
    back: 'Příjem vratek',
    scanCrate: 'Naskenujte vrácenou bednu',
    scanCrateHint:
      'Sken bednu hned uvolní pro další použití a ukončí vazbu lahví k ní. Žádnou lahev nepotvrzuje – každou lahev naskenujte zvlášť.',
    scanCratePlaceholder: 'QR bedny',
    addCrate: 'Uvolnit bednu',
    scanBottles: 'Naskenujte vrácené lahve',
    scanBottlesHint:
      'Každou skutečně vrácenou lahev podle jejího QR – i bez bedny, před bednou nebo později v jiném příjmu.',
    pumps: 'Vadná pumpička −1',
    pumpsCount: (n: number) => `Vadné pumpičky: ${n}`,
    counts: (crates: number, identified: number, defective: number, unreadable: number) =>
      `Bedny ${crates} · přijaté lahve ${identified} (z toho ke skartaci ${defective}) · nečitelné ${unreadable}`,
    close: 'Uzavřít příjem',
    closeHint: 'Nejdřív vyprázdněte starší kontejnery tohoto příjmu (Vyprázdněno).',
    closed: 'Příjem je uzavřený. Neshody lze dořešit i teď.',
  },
  line: {
    crate: (code: string) => `Bedna ${code}`,
    container: 'Krabice bez kódu',
    bottlesTitle: 'Přijaté lahve',
    freed: (n: number) =>
      n === 1
        ? 'Uvolněna · ukončena vazba 1 lahve (nepotvrzuje její návrat)'
        : `Uvolněna · ukončena vazba ${n} lahví (nepotvrzuje jejich návrat)`,
    legacy: 'Starší kontejner z doby před uvolňováním beden: vyprázdněte ho s počtem kusů.',
    order: (code: string, hotel: string | null) =>
      `objednávka ${code}${hotel ? ` · ${hotel}` : ''}`,
    scanBottle: 'Naskenujte lahev',
    scanBottlePlaceholder: 'QR lahve',
    good: 'Dobrá → čeká na mytí',
    defective: 'Vadná → ke skartaci',
    submitBottle: 'Zapsat lahev',
    unreadable: 'Nečitelná lahev +1',
    recorded: (n: number) => `Zaznamenáno kusů: ${n}`,
    physical: 'Fyzicky vyjmuto z tohoto kontejneru (ks)',
    empty: 'Vyprázdněno',
    emptied: (count: number) => `Vyprázdněno · fyzicky ${count} ks`,
    history: (shipped: number, identified: number, without: number) =>
      `Oběh bedny: odesláno ${shipped}, identifikováno ${identified}, bez potvrzeného návratu ${without} (jen pro informaci)`,
    bottles: 'Identifikované lahve',
    noBottles: 'Zatím žádná identifikovaná lahev.',
    fromCrate: (crate: string, order: string) => `z bedny ${crate} · ${order}`,
  },
  outcome: { RETURNED: 'Vrácená, čeká na mytí', RETIRED: 'Ke skartaci' } as Record<string, string>,
  issue: {
    kind: {
      UNREADABLE: 'Nečitelná lahev',
      NOT_DELIVERED: 'Lahev zatím není doručená',
      NOT_IN_CIRCULATION: 'Lahev není v oběhu u hotelu',
      OTHER_SITE: 'Lahev jiné provozovny',
      COUNT_MISMATCH: 'Nesouhlasí počet kusů',
    } as Record<string, string>,
    mismatch: (physical: number, recorded: number) =>
      `fyzicky ${physical}, zaznamenáno ${recorded}`,
    resolution: {
      IDENTIFIED: 'Dořešeno identifikací',
      NOT_AYVO: 'Není AYVO',
      WRITTEN_OFF: 'Odepsáno',
    } as Record<string, string>,
    identify: 'Dořešit naskenováním lahve',
    identifySubmit: 'Dořešit',
    closeOut: 'Uzavřít s důvodem',
    notAyvo: 'Není AYVO',
    writtenOff: 'Odepsat',
    reason: 'Důvod',
  },
  result: {
    identified: (code: string, outcome: string) => `${code}: ${outcome}`,
    repeated: (code: string) => `${code}: už zapsáno v tomto příjmu (první výsledek)`,
    issue: (kind: string, code: string) => `Zapsána neshoda ${code}: ${kind}`,
    crate: (code: string, order: string, freed: number) =>
      `Bedna ${code} přijata a uvolněna (objednávka ${order}) · ukončena vazba ${freed} lahví`,
    crateAgain: (code: string) => `Bedna ${code} už je v tomto příjmu`,
    crateRecorded: (code: string, order: string) =>
      `Bedna ${code} (objednávka ${order}) už je v tomto příjmu zapsaná – nic nového se nezapsalo. Její stav je v seznamu níže: čeká-li na „Vyprázdněno“, potvrďte ho tam.`,
  },
  afterWash: {
    title: 'Po mytí',
    subtitle:
      'Druhý sken vrácené lahve – jen po fyzickém umytí a kontrole. Lahev se stejným QR je pak připravená k plnění; nic se nespotřebuje. Do bedny ji vloží lepicí pracoviště stejným skenem jako novou lahev.',
    scan: 'Naskenujte umytou a zkontrolovanou lahev',
    scanPlaceholder: 'QR lahve',
    submit: 'Po mytí – připravit k plnění',
    hint: 'Lahev, která po mytí neprošla kontrolou, neskenujte – zůstane vrácená.',
    ready: (code: string, product: string | null, design: string | null) =>
      `${code}: Připravená k plnění · Po mytí${product ? ` · ${product}` : ''}${design ? ` · ${design}` : ''}`,
    repeated: (code: string) => `${code}: už je po mytí (první výsledek, nic dalšího se nezapsalo)`,
    waiting: 'Vrácené, čekají na mytí',
    waitingEmpty: 'Žádná lahev nečeká na mytí.',
    withdrawn: 'Vyčleněno – odvolaná etiketa',
    withdrawnHint:
      'Design etikety už není pro produkt schválený. Lahev zůstává vrácená a čeká na výslovné rozhodnutí; nic se nevyřazuje automaticky.',
    withdrawnEmpty: 'Žádná vyčleněná lahev.',
    readyList: 'Připravené k plnění · Po mytí',
    readyHint:
      'Na pracovišti je vložíte do bedny jako novou lahev (stejný QR, bez nové etikety) a naplníte běžnou cestou.',
    readyEmpty: 'Zatím žádná lahev po mytí.',
    count: (shown: number, total: number) => (shown < total ? `${shown} z ${total}` : `${total}`),
    since: 'od',
    noProduct: 'bez vazby na produkt',
    sessionEnded:
      'Přihlášení skončilo. Neodeslané skeny zůstávají uložené v tomto okně – po novém přihlášení stejného uživatele na stejné provozovně je odešlete tlačítkem „Zkusit znovu“.',
    refusals: (n: number) => `Odmítnuté skeny této série (${n}) – lahve odložte stranou`,
    refusalsHide: 'Skrýt',
    refreshFailed:
      'Sken je zapsaný, ale přehled se nepodařilo načíst. Obnovte ho – nic se znovu neodešle.',
    queue: {
      retry: 'Zkusit znovu',
      blockedTitle: 'Výsledek posledního skenu není jistý.',
      blockedText:
        'Spojení selhalo. „Zkusit znovu“ pošle stejný požadavek – lahev se nezapíše dvakrát. Další naskenované lahve čekají a nic se neztratí.',
      leaveGuard: {
        title: 'Skeny nejsou vyřešené',
        text: 'Některý sken čeká na odeslání nebo jeho výsledek není jistý. Stránku nyní nelze opustit – vraťte se a sken dokončete („Zkusit znovu“).',
        stay: 'Zpět k vyřešení skenu',
      },
      waiting: (n: number) => (n === 0 ? 'Žádné další skeny nečekají.' : `Čeká na odeslání: ${n}`),
    },
  },
  errors: {
    RETURN_RECEIPT_NOT_FOUND: 'Příjem neexistuje.',
    RETURN_LINE_NOT_FOUND: 'Kontejner v tomto příjmu neexistuje.',
    RETURN_ISSUE_NOT_FOUND: 'Neshoda neexistuje.',
    RECEIPT_CLOSED: 'Příjem je uzavřený – pozdější kus patří do nového příjmu.',
    LINE_EMPTIED: 'Kontejner už je vyprázdněný.',
    LINES_NOT_EMPTIED: 'Nejdřív vyprázdněte všechny kontejnery.',
    NOT_AYVO_QR: 'Tohle není QR kód AYVO tohoto prostředí.',
    WRONG_ENVIRONMENT: 'QR kód patří jinému prostředí AYVO.',
    NOT_A_CRATE: 'Tohle není QR kód bedny.',
    NOT_A_BOTTLE: 'Tohle není QR kód lahve.',
    UNKNOWN_LABEL: 'Žádná lahev nemá tento kód.',
    CRATE_OF_ANOTHER_SITE: 'Bedna patří jiné provozovně.',
    BOTTLE_OF_ANOTHER_SITE: 'Lahev patří jiné provozovně.',
    CRATE_NOT_DELIVERED: 'Bedna nemá doručený oběh, který by se vracel.',
    CRATE_ALREADY_RETURNED: 'Bedna už je přijatá v jiném příjmu.',
    CRATE_DELIVERED_AFTER_RECEIPT:
      'Bedna byla doručena až po otevření tohoto příjmu – přijměte ji v novém příjmu. Nic se nezapsalo.',
    DELIVERED_AFTER_RECEIPT:
      'Lahev byla doručena až po otevření tohoto příjmu – přijměte ji v novém příjmu. Nic se nezapsalo.',
    CIRCULATION_CHANGED:
      'Lahev je už v dalším oběhu, než který neshoda zaznamenala – neshoda zůstává otevřená.',
    LINE_NOT_EMPTIABLE: 'Přijaté lahve se nevyprazdňují ani nepočítají.',
    BOTTLE_AT_HOTEL:
      'Lahev je podle evidence u hotelu (její bedna se vrátila bez ní) – nejdřív ji přijměte v Příjmu vratek.',
    ALREADY_RECEIVED: 'Lahev už je v tomto příjmu zapsaná; změna je oprava.',
    ALREADY_RECEIVED_ELSEWHERE: 'Lahev už byla přijata v jiném příjmu – znovu se nepočítá.',
    OPEN_ISSUE: 'Lahev má otevřenou neshodu – dořešte ji u té neshody.',
    NOT_IN_THIS_LINE: 'Tato lahev v tomto kontejneru být nemůže.',
    NOT_DELIVERED: 'Lahev zatím není doručená – neshoda zůstává otevřená.',
    NOT_IN_CIRCULATION: 'Lahev není v oběhu – neshoda zůstává otevřená.',
    CONCURRENT_CHANGE: 'Lahev se mezitím změnila – naskenujte ji znovu.',
    ISSUE_RESOLVED: 'Neshoda už je dořešená jinak.',
    ISSUE_NOT_IDENTIFIABLE: 'Tuto neshodu nelze dořešit skenem.',
    ISSUE_NOT_RESOLVABLE: 'Tuto neshodu nelze takto uzavřít.',
    WRONG_BOTTLE: 'Neshoda se týká jiné lahve.',
    HOTEL_NOT_FOUND: 'Hotel neexistuje nebo ho tato provozovna neobsluhuje.',
    IDEMPOTENCY_CONFLICT: 'Požadavek se už použil jinak – zkuste to znovu.',
    NOT_RETURNED:
      'Lahev nečeká na mytí – „Po mytí“ je jen pro lahev přijatou z vratky jako dobrou. Nic se nezapsalo.',
    DESIGN_WITHDRAWN:
      'Etiketa této lahve už není schválená – lahev je vyčleněná (odvolaná etiketa). Nic se nezapsalo.',
    NO_PRODUCT_BINDING: 'Lahev nemá vazbu na produkt – nic se nezapsalo.',
  } as Record<string, string>,
  uncertain: 'Spojení selhalo – výsledek není jistý. „Zkusit znovu“ pošle stejný požadavek.',
  retry: 'Zkusit znovu',
  unconfirmed: {
    title: 'Výsledek nepotvrzený',
    text: 'Server mohl zápis provést. „Zkusit znovu“ pošle tentýž požadavek se stejnou volbou – nic se nezapíše dvakrát.',
    held: 'Další naskenovaný kód zůstává v poli a odešle se až po vyřešení tohoto skenu.',
    dismiss: 'Zahodit (výsledek zůstane neověřený)',
  },
  saved: 'Uloženo.',
  refreshFailed:
    'Zápis je uložený, ale přehled se nepodařilo načíst. Obnovte ho – nic se znovu neodešle.',
  refresh: 'Obnovit',
};
