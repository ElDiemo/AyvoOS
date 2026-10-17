/** Czech strings of Hotely (doc 028). Keys stay language-neutral. */
export const hotelsCs = {
  title: 'Hotely',
  subtitle:
    'Hotely s doručovací adresou, kontaktem a obsluhující provozovnou. Provozovnu určuje AYVO, ne země hotelu.',
  newHotel: 'Nový hotel',
  empty: 'Zatím není založen žádný hotel.',
  columns: {
    code: 'Kód',
    name: 'Hotel',
    city: 'Město',
    country: 'Země',
    site: 'Obsluhující provozovna',
  },
  detail: {
    address: 'Doručovací adresa',
    contact: 'Kontaktní osoba',
    site: 'Obsluhující provozovna',
    created: (by: string) => `Založil(a) ${by}`,
    orders: 'Objednávky',
    ordersHere: 'Objednávky této provozovny.',
    noOrders: 'Hotel zatím nemá žádnou objednávku na této provozovně.',
    newOrder: 'Nová objednávka',
    otherSite: (site: string) =>
      `Hotel obsluhuje provozovna ${site}. Objednávky zakládáte a vidíte po přepnutí na ni.`,
  },
  form: {
    title: 'Nový hotel',
    subtitle:
      'Jedna doručovací adresa a kontakt. Smlouvy, fakturace ani přihlašování hotelu zatím nejsou.',
    name: 'Název hotelu',
    addressLine1: 'Ulice a číslo',
    addressLine2: 'Doplněk adresy (nepovinné)',
    postalCode: 'PSČ',
    city: 'Město',
    country: 'Země',
    countryHelp: 'Dvoupísmenný kód ISO, např. CZ, SK, AT.',
    contactName: 'Kontaktní osoba',
    contactPhone: 'Telefon',
    contactEmail: 'E-mail',
    site: 'Obsluhující provozovna',
    siteHelp: 'Volí se výslovně – země hotelu provozovnu neurčuje.',
    choose: 'Vyberte…',
    submit: 'Založit hotel',
    required: 'Vyplňte prosím.',
    countryInvalid: 'Zadejte dvoupísmenný kód země (např. CZ).',
    phoneInvalid: 'Zadejte telefonní číslo.',
    emailInvalid: 'Zadejte platný e-mail.',
    noSites: 'Žádná aktivní provozovna se skladem – hotel teď nelze založit.',
  },
  errors: {
    FULFILLMENT_SITE_INVALID: 'Vybraná provozovna není aktivní nebo nemá sklad.',
  } as Record<string, string>,
};
