import { describe, expect, it } from 'vitest';
import { csvCell, csvFile, CsvError, parseCsv, suggestMapping, unescapeCell } from './sales-csv.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('sales CSV', () => {
  it('reads semicolons, quotes, empty cells, multi-line notes and Czech accents', () => {
    const csv =
      '\uFEFFNázev;Země;Telefon;Poznámka\r\n' +
      '"Hotel ""U Lípy""";CZ;+420 777 000 111;"první řádek\r\ndruhý; řádek"\r\n' +
      'Penzion Žluťoučký kůň;;0049 30 123;\r\n' +
      '\r\n' +
      'Třetí;SK;;\r\n';
    const p = parseCsv(utf8(csv));
    expect(p).toMatchObject({ encoding: 'UTF-8', delimiter: ';' });
    expect(p.headers).toEqual(['Název', 'Země', 'Telefon', 'Poznámka']);
    expect(p.rows).toEqual([
      {
        row: 2,
        cells: ['Hotel "U Lípy"', 'CZ', '+420 777 000 111', 'první řádek\r\ndruhý; řádek'],
      },
      // The phone stays text: "+" and leading zeros are kept.
      { row: 3, cells: ['Penzion Žluťoučký kůň', '', '0049 30 123', ''] },
      // An empty row still counts, so the numbers match the spreadsheet.
      { row: 5, cells: ['Třetí', 'SK', '', ''] },
    ]);
  });

  it('reads commas and LF, and Windows-1250 from Czech Excel', () => {
    expect(parseCsv(utf8('name,country\nA,CZ')).delimiter).toBe(',');
    // "Žluťoučký" in Windows-1250.
    const cp1250 = new Uint8Array([
      0x4e, 0x61, 0x7a, 0x65, 0x76, 0x0a, 0x8e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd,
    ]);
    const p = parseCsv(cp1250);
    expect(p.encoding).toBe('windows-1250');
    expect(p.rows[0]!.cells).toEqual(['Žluťoučký']);
  });

  it('refuses an empty file, a file without data and an unterminated quote', () => {
    expect(() => parseCsv(utf8(' \n'))).toThrow(CsvError);
    expect(() => parseCsv(utf8('Název;Země\n;\n'))).toThrow(/CSV_NO_DATA/);
    try {
      parseCsv(utf8('Název;Poznámka\nA;"neukončená\npoznámka'));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'CSV_UNTERMINATED_QUOTE', line: 2 });
    }
  });

  it('suggests a mapping from header names; old status columns only as original values', () => {
    expect(
      suggestMapping([
        'Název hotelu',
        'Město',
        'Kontaktní osoba',
        'E-mail',
        'Telefon',
        'Stav',
        'Datum prvního oslovení',
        'Výsledek',
        'Follow-up odeslán',
        'Něco jiného',
        'Název',
      ]),
    ).toEqual([
      'name',
      'city',
      'contactLabel',
      'contactEmail',
      'contactPhone',
      'original',
      'original',
      'original',
      'original',
      'ignore',
      // A second "name" column is not mapped twice.
      'ignore',
    ]);
  });

  it('exports without formula injection and reads its own escape back', () => {
    for (const v of ['=1+1', '+420 777', '-5', '@SUM(A1)', '\tx']) {
      expect(csvCell(v).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
      expect(unescapeCell(csvCell(v).replace(/^"|"$/g, ''))).toBe(v);
    }
    expect(csvCell('a;b "c"')).toBe('"a;b ""c"""');
    expect(csvCell('řádek\nnový')).toBe('"řádek\nnový"');
    expect(csvCell(null)).toBe('');
    expect(csvCell("it's")).toBe("it's");
    expect(csvFile(['A', 'B'], [['1', null]])).toBe('\uFEFFA;B\r\n1;\r\n');
  });
});

describe('import file name', () => {
  it('shows a Czech file name as typed (multipart hands it over as Latin-1)', async () => {
    const { fileNameOf } = await import('./sales-import.service.js');
    const latin1 = Buffer.from('zájemci květen.csv', 'utf8').toString('latin1');
    expect(fileNameOf({ originalname: latin1 })).toBe('zájemci květen.csv');
    expect(fileNameOf({ originalname: 'zajemci.csv' })).toBe('zajemci.csv');
    expect(fileNameOf({ originalname: ' ' })).toBe('import.csv');
  });
});
