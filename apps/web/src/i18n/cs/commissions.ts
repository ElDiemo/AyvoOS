/** Obchod → Provize (doc 068, PR 1a): commission terms per salesperson. */
export const commissionsCs = {
  title: 'Provize',
  subtitle: 'Podmínky provize obchodníků. Částky a výplaty přijdou z Financí v dalších krocích.',
  tabs: { settings: 'Nastavení', mine: 'Moje podmínky' },
  mine: {
    heading: 'Moje podmínky provize',
    readOnly: 'Jen ke čtení. Podmínky nastavuje administrátor.',
  },
  settings: {
    heading: 'Nastavení podmínek',
    pick: 'Obchodník',
    none: 'Žádný obchodník (aktivní uživatel s oprávněním Obchod) zatím není.',
    appliesNew: 'Platí pro nově přiřazené hotely. Hotely, které už podmínky mají, se nemění.',
    newVersion: 'Nová verze podmínek',
  },
  missing: 'Chybí podmínky provize',
  missingHelp: 'Bez podmínek se pro hotely tohoto obchodníka nic nepočítá ani nefakturuje.',
  terms: (initial: string, months: number, maintenance: string) =>
    `${initial} % po ${months} ${months === 1 ? 'měsíc' : months < 5 ? 'měsíce' : 'měsíců'}, potom ${maintenance} %`,
  fields: {
    initialRate: 'Počáteční sazba (%)',
    initialMonths: 'Délka počáteční sazby (celé měsíce)',
    maintenanceRate: 'Udržovací sazba (%) od měsíce N+1',
    reason: 'Důvod změny',
    confirm: 'Potvrzuji novou verzi podmínek',
    rateHelp: '0–100, nejvýš 2 desetinná místa; nezaokrouhluje se.',
  },
  history: {
    heading: 'Historie verzí',
    empty: 'Zatím žádná verze.',
    columns: {
      version: 'Verze',
      terms: 'Podmínky',
      reason: 'Důvod',
      recorded: 'Zapsáno',
    },
    valid: 'platná',
  },
  save: 'Zapsat novou verzi',
  saved: 'Nová verze je zapsaná.',
  errors: {
    rate: 'Zadejte 0–100 s nejvýš 2 desetinnými místy.',
    months: 'Zadejte celé číslo, alespoň 1.',
    reason: 'Uveďte důvod.',
    confirm: 'Potvrďte novou verzi.',
    TERMS_RATE_INVALID: 'Sazba musí být 0–100 % s nejvýš 2 desetinnými místy.',
    TERMS_MONTHS_INVALID: 'Délka musí být celé číslo, alespoň 1 měsíc.',
    SALESPERSON_NOT_ELIGIBLE: 'Tento uživatel není aktivní obchodník.',
    CONCURRENT_CHANGE: 'Podmínky mezitím změnil někdo jiný. Načtěte stránku znovu.',
    failed: 'Uložení se nepodařilo.',
    uncertain: 'Odpověď nedorazila. Odeslání znovu pokračuje ve stejném požadavku.',
  },
} as const;
