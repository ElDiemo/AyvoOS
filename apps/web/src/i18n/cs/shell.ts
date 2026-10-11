/**
 * Czech strings of the AYVO OS application shell and the overview pages (doc 019). Module and
 * page names live here so the navigation, breadcrumbs and page headers always use the same words.
 */
export const shellCs = {
  brand: 'AYVO',
  brandSuffix: 'OS',
  mainNav: 'Hlavní navigace',
  breadcrumb: 'Umístění',
  openMenu: 'Otevřít navigaci',
  closeMenu: 'Zavřít navigaci',
  overview: 'Přehled',
  operations: 'Provoz',
  environment: {
    development: { badge: 'DEV', label: 'Vývojové prostředí – neslouží pro skutečný provoz' },
    test: { badge: 'TEST', label: 'Testovací prostředí – neslouží pro skutečný provoz' },
  },
  modules: {
    warehouse: {
      label: 'Sklad',
      description: 'Fyzické zásoby: příjem zboží, šarže, stav skladu, pohyby a dodavatelé.',
      pages: {
        overview: 'Přehled skladu',
        newReceipt: 'Příjem zboží',
        receipts: 'Příjmy',
        stock: 'Stav skladu',
        movements: 'Pohyby',
        suppliers: 'Dodavatelé',
      },
    },
    production: {
      label: 'Výroba',
      description:
        'Identity lahví, série a tisk etiket, šablony etiket a fyzické nalepení etiket na lahve.',
      pages: {
        overview: 'Přehled výroby',
        bottles: 'Lahve',
        templates: 'Šablony etiket',
        labelActivation: 'Nalepení etiket',
      },
    },
  },
  home: {
    title: 'Přehled',
    subtitle: 'Provozní přehled AYVO OS. Zobrazuje pouze skutečná data z jednotlivých modulů.',
    openWarehouse: 'Otevřít sklad',
    openProduction: 'Otevřít výrobu',
    newBottlesOnHand: 'Nové lahve na skladě',
    receiptsPendingInvoice: 'Příjmy čekající na fakturu',
    suppliers: 'Aktivní dodavatelé',
    bottles: 'Identity lahví',
    awaitingLabel: 'Čeká na nalepení etikety',
    labeled: 'S nalepenou etiketou',
    noStock: 'Na skladě nejsou žádné nové lahve – nalepení etiket nelze zahájit.',
    noSuppliers: 'Zatím není založen žádný dodavatel.',
    noBottles: 'Zatím nejsou vytvořeny žádné identity lahví.',
    lowStockWarning: (items: string) => `Pod minimální zásobou: ${items}.`,
    pendingInvoiceWarning: (n: number) =>
      n === 1 ? '1 příjem čeká na fakturu.' : `${n} příjmů čeká na fakturu.`,
    system: 'Stav systému',
    apiUnreachable: 'Server AYVO OS neodpovídá.',
    services: { api: 'Aplikační server', database: 'Databáze', redis: 'Mezipaměť' },
    up: 'v provozu',
    down: 'nedostupná',
  },
  actions: {
    newReceipt: 'Příjem zboží',
    labelActivation: 'Nalepit etikety',
    createBottles: 'Vytvořit lahve',
  },
  common: {
    notFoundTitle: 'Stránka nenalezena',
    notFoundText: 'Tato stránka, lahev nebo záznam neexistuje.',
    backHome: 'Zpět na přehled',
    errorTitle: 'Stránku se nepodařilo načíst',
    errorText:
      'Server AYVO OS neodpověděl podle očekávání. Nic nebylo změněno. Zkuste to znovu; pokud chyba trvá, zkontrolujte stav systému na přehledu.',
    retry: 'Zkusit znovu',
    previous: '← Předchozí',
    next: 'Další →',
    page: (page: number, pages: number) => `Strana ${page} z ${pages}`,
    pagination: 'Stránkování',
  },
};
