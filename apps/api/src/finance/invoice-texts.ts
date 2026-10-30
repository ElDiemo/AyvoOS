import type { DocumentLanguage } from '@ayvo/types';

/**
 * The words of an invoice document, frozen into its snapshot at issuing (doc 040 §12), so a later
 * change here never changes an issued document. A draft for the owner's review: nothing here is a
 * legal or VAT wording. `testNote` only says a TEST document is not a tax document; the wording of
 * live VAT notes, reverse charge and the tax-point label is the accountant's (doc 040 §7).
 */
export interface InvoiceTexts {
  invoice: string;
  period: string;
  hotel: string;
  hotels: string;
  supplier: string;
  customer: string;
  companyId: string;
  vatId: string;
  issuedOn: string;
  taxPointOn: string;
  dueOn: string;
  variableSymbol: string;
  item: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  base: string;
  vat: string;
  totalDue: string;
  paymentDetails: string;
  accountNumber: string;
  amount: string;
  qrCaption: string;
  lineService: string;
  unitRooms: string;
  /** Goes into the QR Platba message: ASCII only (spayd refuses anything else). */
  paymentMessage: string;
  filePrefix: string;
  testMark: string;
  testMarkInvalid: string;
  testBanner: string;
  testNote: string;
  /** The invoice e-mail (doc 043): frozen with the invoice, so it always matches its PDF. */
  mail: {
    /** With "{number}" and "{period}". */
    intro: string;
    greeting: string;
    reply: string;
    signature: string;
    testNotice: string;
    testSubjectPrefix: string;
  };
}

export const INVOICE_TEMPLATE_VERSION = 1;

const TEXTS: Record<DocumentLanguage, InvoiceTexts> = {
  cs: {
    invoice: 'Faktura',
    period: 'Fakturované období',
    hotel: 'hotel',
    hotels: 'hotely',
    supplier: 'Dodavatel',
    customer: 'Odběratel',
    companyId: 'IČO',
    vatId: 'DIČ',
    issuedOn: 'Datum vystavení',
    taxPointOn: 'DUZP',
    dueOn: 'Datum splatnosti',
    variableSymbol: 'Variabilní symbol',
    item: 'Položka',
    quantity: 'Množství',
    unitPrice: 'Cena za jednotku',
    lineTotal: 'Celkem',
    base: 'Základ',
    vat: 'DPH',
    totalDue: 'Celkem k úhradě',
    paymentDetails: 'Platební údaje',
    accountNumber: 'Číslo účtu',
    amount: 'Částka',
    qrCaption: 'QR Platba',
    lineService: 'Služba AYVO',
    unitRooms: 'pok.',
    paymentMessage: 'Faktura',
    filePrefix: 'faktura',
    testMark: 'TESTOVACÍ DOKLAD',
    testMarkInvalid: 'NEPLATNÝ',
    testBanner: 'TESTOVACÍ DOKLAD — NEPLATNÝ, NEPLATIT (AYVO OS DEV)',
    testNote:
      'Testovací doklad – nejde o daňový doklad. DPH a účetní pravidla zatím nejsou schválena.',
    mail: {
      greeting: 'Dobrý den,',
      intro: 'v příloze posíláme fakturu {number} za období {period}.',
      reply: 'Máte-li dotaz, odpovězte prosím na tento e-mail.',
      signature: 'Tým AYVO',
      testNotice: 'TESTOVACÍ E-MAIL: doklad je neplatný, neplaťte.',
      testSubjectPrefix: '[TEST]',
    },
  },
  en: {
    invoice: 'Invoice',
    period: 'Billing period',
    hotel: 'hotel',
    hotels: 'hotels',
    supplier: 'Supplier',
    customer: 'Customer',
    companyId: 'Company ID',
    vatId: 'VAT ID',
    issuedOn: 'Issue date',
    taxPointOn: 'Tax point date',
    dueOn: 'Due date',
    variableSymbol: 'Variable symbol',
    item: 'Item',
    quantity: 'Quantity',
    unitPrice: 'Unit price',
    lineTotal: 'Total',
    base: 'Net',
    vat: 'VAT',
    totalDue: 'Total due',
    paymentDetails: 'Payment details',
    accountNumber: 'Account number',
    amount: 'Amount',
    qrCaption: 'QR payment',
    lineService: 'AYVO service',
    unitRooms: 'rooms',
    paymentMessage: 'Invoice',
    filePrefix: 'invoice',
    testMark: 'TEST DOCUMENT',
    testMarkInvalid: 'NOT VALID',
    testBanner: 'TEST DOCUMENT — NOT VALID, DO NOT PAY (AYVO OS DEV)',
    testNote: 'Test document – not a tax document. VAT and accounting rules are not yet approved.',
    mail: {
      greeting: 'Hello,',
      intro: 'please find attached invoice {number} for the period {period}.',
      reply: 'If you have any questions, please reply to this e-mail.',
      signature: 'The AYVO team',
      testNotice: 'TEST E-MAIL: this document is not valid, do not pay.',
      testSubjectPrefix: '[TEST]',
    },
  },
  de: {
    invoice: 'Rechnung',
    period: 'Abrechnungszeitraum',
    hotel: 'Hotel',
    hotels: 'Hotels',
    supplier: 'Lieferant',
    customer: 'Kunde',
    companyId: 'Firmen-ID',
    vatId: 'USt-IdNr.',
    issuedOn: 'Rechnungsdatum',
    taxPointOn: 'Leistungsdatum',
    dueOn: 'Fälligkeitsdatum',
    variableSymbol: 'Variabel-Symbol',
    item: 'Position',
    quantity: 'Menge',
    unitPrice: 'Einzelpreis',
    lineTotal: 'Gesamt',
    base: 'Netto',
    vat: 'USt.',
    totalDue: 'Zu zahlen',
    paymentDetails: 'Zahlungsdaten',
    accountNumber: 'Kontonummer',
    amount: 'Betrag',
    qrCaption: 'QR-Zahlung',
    lineService: 'AYVO-Service',
    unitRooms: 'Zimmer',
    paymentMessage: 'Rechnung',
    filePrefix: 'rechnung',
    testMark: 'TESTBELEG',
    testMarkInvalid: 'UNGÜLTIG',
    testBanner: 'TESTBELEG — UNGÜLTIG, NICHT BEZAHLEN (AYVO OS DEV)',
    testNote:
      'Testbeleg – kein Steuerbeleg. Umsatzsteuer- und Buchhaltungsregeln sind noch nicht freigegeben.',
    mail: {
      greeting: 'Guten Tag,',
      intro: 'anbei erhalten Sie die Rechnung {number} für den Zeitraum {period}.',
      reply: 'Bei Fragen antworten Sie bitte auf diese E-Mail.',
      signature: 'Ihr AYVO-Team',
      testNotice: 'TEST-E-MAIL: Dieser Beleg ist ungültig, bitte nicht bezahlen.',
      testSubjectPrefix: '[TEST]',
    },
  },
};

export const invoiceTexts = (language: DocumentLanguage): InvoiceTexts => TEXTS[language];
