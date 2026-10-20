import type { CarrierSettingsProblem } from '@ayvo/types';

/** Správa systému → Provozovny → Dopravci a expedice (doc 029 §9). */
export const carriersCs = {
  connections: {
    nav: 'Dopravci',
    title: 'Připojení dopravců',
    subtitle:
      'Přístupové údaje k rozhraním dopravců. Ukládají se šifrovaně na serveru; tajný klíč se po uložení už nikdy nezobrazí – lze ho jen nahradit.',
    environment: { TEST: 'Testovací prostředí', PRODUCTION: 'Produkce' },
    credentials: {
      SET: 'nastaveno',
      MISSING: 'nenastaveno',
      UNREADABLE: 'uložené údaje nelze přečíst (jiný klíč serveru) – zadejte je znovu',
    },
    source: {
      ADMIN: 'zadáno v administraci',
      SERVER: 'ze serverového souboru',
    },
    keyMissing:
      'Server nemá šifrovací klíč pro přístupové údaje – zadávat je zde nelze. Klíč doplní správce serveru.',
    clientId: 'Client ID',
    clientSecret: 'Client secret',
    secretHint: 'Zadaná hodnota se nikde nezobrazí a po uložení se pole vyprázdní.',
    reason: 'Důvod změny',
    replace: 'Uložit přístupové údaje',
    replacing: 'Ukládám…',
    saved: 'Přístupové údaje uloženy.',
    accountWarning:
      'Pokud zadáte údaje jiného účtu, přepravy vytvořené dosavadním účtem se přes toto připojení už neověří ani nezruší (zobrazí se jako nedostupné) a provozovny musí připojení ověřit znovu.',
    lastChange: (at: string, by: string) => `Naposledy změněno ${at} (${by}).`,
    productionAbsent:
      'Produkční připojení v této verzi neexistuje – DEV používá výhradně testovací prostředí PPL.',
    errors: {
      CREDENTIALS_KEY_MISSING: 'Server nemá šifrovací klíč – přístupové údaje nelze uložit.',
    } as Record<string, string>,
  },
  manageConnections: 'Spravovat přístupové údaje',
  title: 'Dopravci a expedice',
  ppl: 'PPL',
  intro:
    'Nastavení PPL pro tuto provozovnu. Nové přepravy vzniknou jen s úplným, ověřeným a zapnutým nastavením; již vytvořené přepravy si ponechávají nastavení, se kterým vznikly.',
  enabled: 'Používat PPL pro nové přepravy této provozovny',
  testEnvironment: 'Testovací prostředí',
  testEnvironmentHint:
    'Testovací prostředí PPL: nevznikají skutečné zásilky ani svozy a štítky nejsou platné pro přepravu.',
  connection: 'Připojení',
  connectionNone: '– vyberte připojení –',
  connectionName: (code: string, environment: 'TEST' | 'PRODUCTION') =>
    `${code} (${environment === 'TEST' ? 'testovací prostředí' : 'produkce'})`,
  credentials: 'Přístupové údaje na serveru',
  credentialsSet: 'nastaveno',
  credentialsMissing: 'nenastaveno',
  credentialsHint:
    'Přístupové údaje se vkládají jen na serveru (nikdy sem). Adresa rozhraní PPL je pevně daná připojením.',
  sender: 'Odesílatel',
  senderName: 'Název',
  street: 'Ulice a číslo',
  city: 'Město',
  postalCode: 'PSČ',
  country: 'Země (kód ISO, např. CZ)',
  contact: 'Kontaktní osoba',
  phone: 'Telefon',
  email: 'E-mail',
  prefill: 'Předvyplnit z adresy provozovny',
  prefillHint: 'Předvyplněné údaje zkontrolujte – PPL je vytiskne na štítek jako odesílatele.',
  latinHint:
    'PPL přijímá jen latinku: diakritika se při odeslání odstraní (např. „Přerov“ → „Prerov“).',
  service: 'Výchozí služba PPL',
  serviceNone: '– vyberte službu –',
  serviceNotVerified: 'Služby se načtou z PPL po ověření připojení.',
  label: 'Štítky',
  layout: 'Rozvržení',
  layoutSingle: 'Jeden štítek na balík',
  layoutA4: 'Navíc souhrnný dokument A4',
  formatsHint:
    'PPL dodá každý štítek jako PDF (náhled a stažení) a pro tisk jako ZPL v rozlišení tiskárny provozovny – tiskárny se nastavují v sekci Tiskárny, ne u dopravce.',
  labelSizeHint:
    'Rozměr štítku PPL zatím není potvrzený (otevřený dotaz na PPL) – štítky se nikdy neořezávají ani nezmenšují.',
  save: 'Uložit nastavení',
  saving: 'Ukládám…',
  saved: 'Nastavení uloženo.',
  verify: 'Ověřit připojení',
  verifying: 'Ověřuji…',
  verifyHint:
    'Ověření získá přístup k PPL a načte seznam služeb. Nevytvoří žádnou zásilku ani svoz.',
  verifySaveFirst: 'Před ověřením nastavení uložte.',
  verifiedAt: (at: string, by: string, connection: string) =>
    `Ověřeno ${at} (${by}), připojení ${connection}.`,
  verifyOk: (n: number) =>
    `Připojení funguje. PPL nabízí ${n} ${n === 1 ? 'službu' : n >= 2 && n <= 4 ? 'služby' : 'služeb'}.`,
  notVerified: 'Připojení zatím nebylo ověřeno.',
  ready: 'Nastavení je úplné – nové přepravy této provozovny mohou použít PPL.',
  problemsTitle: 'Nové přepravy PPL zatím nelze vytvořit:',
  problem: {
    DISABLED: 'PPL není pro tuto provozovnu zapnuté.',
    NO_CONNECTION: 'Není vybrané připojení.',
    UNKNOWN_CONNECTION: 'Vybrané připojení na serveru neexistuje.',
    CREDENTIALS_MISSING: 'Server nemá přístupové údaje k vybranému připojení.',
    CREDENTIALS_UNREADABLE:
      'Uložené přístupové údaje nelze přečíst (jiný klíč serveru) – zadejte je znovu.',
    SENDER_INCOMPLETE: 'Odesílatel není úplný (název, ulice, město, PSČ a země).',
    NOT_VERIFIED: 'Připojení nebylo ověřeno.',
    VERIFIED_WITH_ANOTHER_CONNECTION:
      'Ověření proběhlo s jiným připojením nebo účtem – ověřte připojení znovu.',
    NO_PRODUCT: 'Není vybraná služba PPL.',
    PRODUCT_NOT_VERIFIED: 'Vybraná služba není v seznamu služeb z posledního ověření.',
  } satisfies Record<CarrierSettingsProblem, string>,
  errors: {
    UNKNOWN_CONNECTION: 'Toto připojení na serveru neexistuje.',
    PRODUCT_NOT_VERIFIED: 'Službu lze vybrat jen ze seznamu načteného ověřením s tímto připojením.',
    NO_CONNECTION: 'Nejdřív vyberte a uložte připojení.',
    CREDENTIALS_MISSING: 'Server nemá přístupové údaje k tomuto připojení.',
  } as Record<string, string>,
  lastChange: (at: string, by: string) => `Naposledy změněno ${at} (${by}).`,
};
