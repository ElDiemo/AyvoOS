/**
 * Czech strings of Výroba → Pracoviště and Správa pracovišť (doc 026, A2). Station codes and
 * category codes stay language-neutral.
 */
export const workstationsCs = {
  mode: { LABELING: 'Lepení etiket', FILLING: 'Plnění' } as Record<string, string>,
  status: { ACTIVE: 'V provozu', INACTIVE: 'Vyřazené z provozu' } as Record<string, string>,
  manage: {
    title: 'Správa pracovišť',
    subtitle:
      'Pracoviště jsou pracovní režimy této provozovny (lepení, plnění jedné kategorie) s vlastním QR. QR pracoviště nikomu nedává oprávnění.',
    empty: 'V této provozovně zatím není žádné pracoviště.',
    new: 'Nové pracoviště',
    code: 'Kód',
    codeHelp: 'Velká písmena, číslice, pomlčka; např. FILL-GEL-1. Kód se později nemění.',
    codeInvalid: 'Kód: 2–40 znaků, velká písmena, číslice, „-“ nebo „_“.',
    name: 'Název',
    modeLabel: 'Režim',
    category: 'Kategorie plnění',
    categoryHelp: 'Plnicí pracoviště plní jen tuto kategorii.',
    choose: 'Vyberte…',
    required: 'Povinný údaj.',
    reason: 'Důvod (povinný)',
    reasonPlaceholder: 'Např. nová plnicí linka',
    reasonRequired: 'Uveďte důvod (alespoň 3 znaky).',
    submit: 'Založit pracoviště',
    saving: 'Ukládám…',
    created: (code: string) => `Pracoviště ${code} je založené.`,
    warehouse: 'Sklad',
    occupiedBy: (user: string) => `Pracuje: ${user}`,
    leaseExpired: 'bez aktivity – lze převzít',
    free: 'Volné',
    deactivate: 'Vyřadit z provozu',
    reactivate: 'Vrátit do provozu',
    deactivateTitle: (code: string) => `Vyřadit pracoviště ${code} z provozu?`,
    deactivateText:
      'Na vyřazeném pracovišti nelze začít práci. Pokud na něm někdo právě pracuje, jeho relace se ukončí s uvedeným důvodem. Rozpracované bedny zůstávají beze změny.',
    reactivateTitle: (code: string) => `Vrátit pracoviště ${code} do provozu?`,
    cancel: 'Zrušit',
    printTitle: 'QR štítek pracoviště',
    printHelp:
      'Rozměr štítku zatím není schválený; zadejte rozměr skutečného štítku. QR obsahuje jen stálou adresu pracoviště.',
    width: 'Šířka (mm)',
    height: 'Výška (mm)',
    sizeInvalid: 'Celé číslo 20–300 mm.',
    tooSmall: 'Na takový štítek se čitelný QR nevejde.',
    download: 'Stáhnout PDF štítku',
  },
  station: {
    title: 'Pracoviště',
    subtitle:
      'Naskenujte QR kód pracoviště, u kterého stojíte. Pracoviště zůstane zvolené, dokud ho neopustíte.',
    scanStation: 'Naskenujte QR pracoviště',
    scanPlaceholder: 'QR kód pracoviště',
    scanHelp: 'Čtečka odešle kód sama (Enter). Můžete také vložit adresu z QR kódu.',
    checking: 'Ověřuji…',
    opened: (name: string) => `Pracoviště ${name} je otevřené.`,
    resumed: (name: string) => `Pokračujete na pracovišti ${name}.`,
    takenOver: (name: string) => `Převzali jste pracoviště ${name}.`,
    site: 'Provozovna',
    warehouse: 'Sklad',
    worker: 'Pracuje',
    since: 'Od',
    leave: 'Opustit pracoviště',
    leaveHelp:
      'Opuštěním pracoviště ho předáte: další oprávněný pracovník pak jen naskenuje jeho QR. Rozpracované bedny se tím nemění.',
    left: 'Pracoviště jste opustili. Může na něm pokračovat jiný pracovník.',
    nextSteps:
      'Lepení etiket do bedny a plnění se na pracovišti zapnou v navazujícím kroku (A3/A4). Teď lze pracoviště otevřít, předat a převzít.',
    inUseTitle: (holder: string) => `Na tomto pracovišti pracuje ${holder}.`,
    inUseText: (since: string, expired: boolean) =>
      expired
        ? `Poslední aktivita ${since}; relace je bez aktivity.`
        : `Poslední aktivita ${since}.`,
    inUseHandover:
      'Požádejte pracovníka, aby pracoviště opustil (předal). Vynuceně ho může převzít jen vedoucí výroby.',
    takeover: 'Převzít pracoviště',
    takeoverTitle: 'Vynuceně převzít pracoviště?',
    takeoverText: (holder: string) =>
      `Relace pracovníka ${holder} se ukončí a pracoviště přejde na vás. Převzetí se zaznamená s důvodem.`,
    takeoverReason: 'Důvod převzetí (povinný)',
    elsewhere: (name: string) =>
      `Nejprve opusťte pracoviště ${name}. Na jiném pracovišti nelze začít, dokud máte otevřené jiné.`,
    endedByOther: (station: string, by: string, at: string, reason: string | null) =>
      `Vaše práce na pracovišti ${station} byla ukončena (${by}, ${at})${reason ? `: ${reason}` : ''}.`,
    endedTitle: 'Pracoviště už není vaše',
    lostSession:
      'Pracoviště vám bylo mezitím odebráno (převzetí nebo vyřazení). Naskenujte QR pracoviště znovu.',
  },
  errors: {
    NOT_AYVO_QR: 'Toto není QR kód AYVO tohoto prostředí.',
    WRONG_ENVIRONMENT: 'QR kód patří jinému prostředí AYVO.',
    NOT_A_STATION: 'Toto není QR kód pracoviště (je to lahev nebo bedna).',
    UNKNOWN_STATION: 'Pracoviště s tímto QR kódem neexistuje.',
    STATION_INACTIVE: 'Toto pracoviště je vyřazené z provozu.',
    STATION_OF_ANOTHER_SITE:
      'Pracoviště patří jiné provozovně, než ve které pracujete. Provozovnu změňte v horní liště.',
    MODE_NOT_PERMITTED: 'Na pracovišti tohoto druhu nemáte oprávnění pracovat.',
    SESSION_NOT_OWNED: 'Pracoviště už není vaše.',
    SESSION_ENDED: 'Tato relace už skončila. Obnovte stránku.',
    OWN_SESSION: 'Toto pracoviště je už vaše.',
    CODE_TAKEN: 'Pracoviště s tímto kódem už existuje.',
    UNKNOWN_CATEGORY: 'Neznámá kategorie.',
    ALREADY_INACTIVE: 'Pracoviště je už vyřazené.',
    ALREADY_ACTIVE: 'Pracoviště je už v provozu.',
    SITE_WITHOUT_WAREHOUSE: 'Provozovna nemá sklad.',
    SITE_REQUIRED: 'Nejprve zvolte provozovnu, ve které pracujete.',
    FORBIDDEN: 'K této akci nemáte oprávnění.',
    IDEMPOTENCY_CONFLICT: 'Požadavek se změnil během odesílání. Odešlete jej znovu.',
  } as Record<string, string>,
  invalid: 'Údaje nejsou platné.',
  network:
    'Spojení se serverem selhalo. Výsledek není jistý – zkuste to znovu, opakování je bezpečné.',
  failed: 'Akci se nepodařilo dokončit.',
};
