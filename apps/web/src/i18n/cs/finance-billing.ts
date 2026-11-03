/**
 * Finance → Fakturační podmínky (doc 040, N3A-1 settings in the UI). The record is the billing terms
 * of a hotel, not a legal contract (owner 2026-11-03): the UI never calls it a contract.
 */
export const billingCs = {
  financeLanguageUnconfirmed:
    'Nepodařilo se ověřit, že Finance ukládají jazyk faktur (přechod mezi verzemi nebo výpadek). Plátce nebyl uložen; zkuste to později.',
  title: 'Fakturační podmínky',
  subtitle:
    'Kdo za hotel platí (odběratel = firma), kolik pokojů a za jakou cenu se účtuje a výchozí ceník. Každá změna je nová verze s důvodem; nic se nepřepisuje.',
  agreements: 'Fakturační podmínky',
  noAgreements: 'Zatím žádné fakturační podmínky.',
  newAgreement: 'Nové fakturační podmínky hotelu',
  noFreeHotel: 'Všechny hotely už fakturační podmínky mají (nebo žádný hotel neexistuje).',
  needCustomer: 'Nejdřív založte odběratele.',
  noAgreementsNoCustomer:
    'Zatím žádné fakturační podmínky. Potřebují odběratele – firmu, které se fakturuje.',
  createCustomer: 'Založit odběratele',
  customers: 'Odběratelé (fakturační firmy)',
  customersHelp:
    'Odběratel je firma, které se fakturuje – ne hotel. Jedna firma může platit za více hotelů.',
  noCustomers: 'Zatím žádný odběratel.',
  newCustomer: 'Nový odběratel',
  priceList: 'Výchozí ceník (cena za pokoj a měsíc bez DPH)',
  priceListHelp:
    'Platí pro fakturační podmínky bez vlastní ceny ve stejné měně, od zvoleného měsíce. Ceny jsou bez DPH. Oprava = nová verze téhož měsíce.',
  noPrices: 'Zatím žádná cena.',
  newPrice: 'Nová cena',
  current: (rooms: number, price: string) => `${rooms} pokojů · ${price}`,
  ownPrice: 'vlastní cena',
  defaultPrice: 'dle ceníku',
  history: 'Historie verzí',
  version: (v: number) => `verze ${v}`,
  revision: (r: number) => `revize ${r}`,
  recorded: (at: string, by: string) => `${at}, ${by}`,
  newVersion: 'Nová verze',
  back: 'Fakturační podmínky',
  save: 'Uložit',
  saving: 'Ukládám…',
  saved: 'Uloženo.',
  // A form edited from an older version (review BILL88-R1): never saved over the newer one.
  staleVersion:
    'Mezitím uložil někdo jiný novější verzi. Vaše rozepsané hodnoty vycházejí ze starší verze, proto je nelze uložit. Načtěte aktuální verzi a změnu zopakujte.',
  loadCurrent: 'Načíst aktuální verzi (rozepsané změny se zahodí)',
  stalePrice: (price: string) =>
    `Mezitím byla pro tento měsíc uložena cena ${price}. Zkontrolujte ji; uložením ji nahradíte svou cenou.`,
  rebasePrice: 'Rozumím, navázat na aktuální cenu',
  fields: {
    hotel: 'Hotel',
    customer: 'Odběratel (plátce)',
    effectiveFrom: 'Platí od měsíce',
    contractNumber: 'Číslo smlouvy',
    billedRooms: 'Účtované pokoje',
    ownPrice: 'Vlastní cena za pokoj a měsíc bez DPH (prázdné = ceník)',
    currency: 'Měna',
    paymentTermsDays: 'Splatnost (dní)',
    billingTiming: 'Fakturace',
    validFrom: 'Podmínky platí od',
    validTo: 'Podmínky platí do (prázdné = neurčito)',
    reason: 'Důvod (povinný)',
    legalName: 'Název firmy',
    companyId: 'IČO',
    vatId: 'DIČ',
    addressLine1: 'Ulice a číslo',
    addressLine2: 'Doplněk adresy',
    postalCode: 'PSČ',
    city: 'Město',
    countryCode: 'Země',
    billingEmail: 'E-mail pro faktury',
    documentLanguage: 'Jazyk faktur a e-mailů',
    price: 'Cena za pokoj a měsíc bez DPH',
  },
  toHotel: 'Karta hotelu',
  backToHotel: 'Zpět na kartu hotelu',
  defaultPriceLink: 'výchozí ceník',
  decimalInvalid: 'Částku zadejte jako 1 500,50 (nejvýš 2 desetinná místa). Nic se neuložilo.',
  currentData: 'Aktuální údaje',
  edit: 'Upravit',
  historyOpen: (n: number) => `Zobrazit historii (${n})`,
  agreementsSubtitle:
    'Jedny fakturační podmínky na hotel, s verzemi. Evidence pro fakturaci, ne právní smlouva. Hotel se zakládá v Hotelech.',
  newPayerHere:
    'Založení zde neztratí rozepsané fakturační podmínky. Plátce je firma, ne hotel; všechny plátce najdete v záložce Plátci.',
  customersTitle: 'Plátci',
  customersSubtitle:
    'Firmy, kterým se fakturuje. Jedna firma může platit za více hotelů a nemusí být jejich vlastníkem ani provozovatelem.',
  payerHotels: (month: string) => `Hotely, za které platí (${month.slice(5)}/${month.slice(0, 4)})`,
  payerHelp: 'Podle fakturačních podmínek platných v tomto měsíci.',
  payerNoHotels: 'V tomto měsíci nemá žádné platné fakturační podmínky.',
  pricesTitle: 'Výchozí ceník',
  pricesSubtitle:
    'Jediné místo výchozí ceny za pokoj a měsíc bez DPH. Fakturační podmínky s vlastní cenou ji nepoužívají.',
  chooseLanguage: 'Vyberte jazyk',
  languages: { cs: 'čeština', en: 'angličtina', de: 'němčina' } as Record<string, string>,
  languageMissing: 'jazyk dokumentů nevybrán',
  timing: { ADVANCE: 'předem', ARREARS: 'zpětně' } as Record<string, string>,
  errors: {
    CONCURRENT_CHANGE: 'Údaje mezitím změnil někdo jiný – nic se neuložilo.',
    AGREEMENT_EXISTS: 'Tento hotel už fakturační podmínky má.',
    CUSTOMER_NOT_FOUND: 'Zvolený odběratel neexistuje.',
    HOTEL_NOT_FOUND: 'Hotel neexistuje.',
  } as Record<string, string>,
};
