import { describe, expect, it } from 'vitest';
import { ReportExportError, checkExportReport, crc32, excelDate, exportAmount, exportFileName, neutraliseFormula, toCsv, toXlsx, zipStore, type ExportReport } from '../src';

const report = (over: Partial<ExportReport> = {}): ExportReport => ({
  title: 'Trial balance',
  orgName: 'Acme, "Retail" Pvt Ltd',
  period: 'As of 31 Oct 2026',
  currency: 'INR',
  generatedAt: '2026-11-03T10:15:30.000Z',
  columns: [
    { label: 'Account', type: 'text' },
    { label: 'Date', type: 'date' },
    { label: 'Debit', type: 'money' },
    { label: 'Share', type: 'percent' },
  ],
  rows: [
    { cells: ['Assets', null, null, null], style: 'section' },
    { cells: ['1000 Cash', '2026-10-31', '1234567.89', '12.5'], indent: 1 },
    { cells: ['=HYPERLINK("http://x")', '2026-10-01', '-50.10', null] },
    { cells: ['Line one\nline two', null, '0.00', null] },
    { cells: ['Total', null, '1234517.79', '100.0'], style: 'total' },
  ],
  notes: ['Debits equal credits.', '-not a formula'],
  fileName: 'Trial Balance 2026/10/31',
  ...over,
});

/** Reads the stored ZIP entries back, checking signatures, sizes and CRCs. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let p = 0;
  while (v.getUint32(p, true) === 0x04034b50) {
    expect(v.getUint16(8, true)).toBe(0);
    const crc = v.getUint32(p + 14, true);
    const size = v.getUint32(p + 18, true);
    const nameLen = v.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const data = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    p += 30 + nameLen + size;
  }
  const endAt = bytes.length - 22;
  expect(v.getUint32(endAt, true)).toBe(0x06054b50);
  expect(v.getUint16(endAt + 10, true)).toBe(out.size);
  expect(v.getUint32(endAt + 16, true)).toBe(p);
  return out;
}

describe('report export model', () => {
  it('rejects rows with the wrong number of cells, bad numbers and bad dates', () => {
    expect(() => checkExportReport(report({ rows: [{ cells: ['x'] }] }))).toThrow(/1 cells for 4 columns/);
    expect(() => checkExportReport(report({ rows: [{ cells: ['x', null, '1,000', null] }] }))).toThrow(/not a number/);
    expect(() => checkExportReport(report({ rows: [{ cells: ['x', '31/10/2026', null, null] }] }))).toThrow(ReportExportError);
    expect(() => checkExportReport(report({ columns: [], rows: [] }))).toThrow(/at least one column/);
    expect(() => checkExportReport(report())).not.toThrow();
  });

  it('makes safe file names', () => {
    expect(exportFileName(report(), 'xlsx')).toBe('trial-balance-2026-10-31.xlsx');
    expect(exportFileName(report({ fileName: '../../' }), 'csv')).toBe('report.csv');
  });

  it('formats export amounts with lakh grouping for INR and thousands otherwise', () => {
    expect(exportAmount('1234567.8', 'INR')).toContain('12,34,567.80');
    expect(exportAmount('-1234567.8', 'USD')).toContain('1,234,567.80');
    expect(exportAmount('-1234567.8', 'USD')).toMatch(/^-/);
  });
});

describe('CSV', () => {
  it('neutralises text a spreadsheet would run as a formula', () => {
    expect(neutraliseFormula('=1+1')).toBe("'=1+1");
    expect(neutraliseFormula('+91 98')).toBe("'+91 98");
    expect(neutraliseFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutraliseFormula('\tx')).toBe("'\tx");
    expect(neutraliseFormula('Cash')).toBe('Cash');
  });

  it('writes a BOM, CRLF lines, the header block, quoted fields and plain decimal amounts', () => {
    const csv = toCsv(report());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Trial balance');
    expect(lines[1]).toBe('"Acme, ""Retail"" Pvt Ltd"');
    expect(lines[2]).toBe('As of 31 Oct 2026 · INR');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('Account,Date,Debit,Share');
    expect(lines[5]).toBe('Assets,,,');
    expect(lines[6]).toBe('  1000 Cash,2026-10-31,1234567.89,12.5');
    expect(lines[7]).toBe(`"'=HYPERLINK(""http://x"")",2026-10-01,-50.10,`);
    // A negative amount stays a number; only text is neutralised.
    expect(csv).toContain('"Line one\nline two",,0.00,');
    expect(csv).toContain("'-not a formula");
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('XLSX', () => {
  it('computes CRC-32 and Excel date serials correctly', () => {
    expect(crc32(new Uint8Array([]))).toBe(0);
    expect(crc32(new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0))))).toBe(0xcbf43926);
    expect(excelDate('1900-03-01')).toBe(61);
    expect(excelDate('2026-10-31')).toBe(46326);
  });

  it('builds a valid stored ZIP', () => {
    const z = unzip(zipStore([{ name: 'a.txt', data: new Uint8Array([104, 105]) }, { name: 'dir/ü.xml', data: new Uint8Array([]) }]));
    expect([...z.keys()]).toEqual(['a.txt', 'dir/ü.xml']);
    expect(z.get('a.txt')).toBe('hi');
  });

  it('writes a workbook with numbers, dates, styles, a frozen header and escaped text', () => {
    const files = unzip(toXlsx(report()));
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="C7" s="13"><v>1234567.89</v></c>');
    expect(sheet).toContain('<c r="B7" s="5"><v>46326</v></c>');
    expect(sheet).toContain('<c r="C8" s="2"><v>-50.1</v></c>');
    expect(sheet).toContain('<c r="C10" s="14"><v>1234517.79</v></c>');
    expect(sheet).toContain('<c r="D10" s="11"><v>100</v></c>');
    // Inline strings are escaped; in a typed cell a leading "=" is text, never a formula.
    expect(sheet).toContain('=HYPERLINK(&quot;http://x&quot;)');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('    1000 Cash');
    expect(sheet).toContain('ySplit="5"');
    expect(sheet).toContain('Exported 2026-11-03 10:15 UTC from Talk2Tax');
    expect(files.get('xl/workbook.xml')).toContain('name="Trial balance"');
    expect(files.get('docProps/core.xml')).toContain('Acme, &quot;Retail&quot; Pvt Ltd');
    expect(files.get('xl/styles.xml')).toContain('##\\,##\\,##0.00');
    expect(unzip(toXlsx(report({ currency: 'USD' }))).get('xl/styles.xml')).toContain('#,##0.00;-#,##0.00');
  });

  it('picks the lakh or crore format band by the size of each amount', () => {
    const rows = ['99999.99', '-100000', '9999999.99', '10000000', '-123456789012.5'].map((v) => ({ cells: ['x', null, v, null] }));
    const sheet = unzip(toXlsx(report({ rows }))).get('xl/worksheets/sheet1.xml')!;
    expect([...sheet.matchAll(/r="C\d+" s="(\d+)"><v>/g)].map((m) => +m[1]!)).toEqual([2, 13, 13, 15, 19]);
    const styles = unzip(toXlsx(report({ rows }))).get('xl/styles.xml')!;
    expect(styles).toContain('numFmtId="171" formatCode="##\\,##\\,##\\,##\\,##\\,##\\,##0.00;-##\\,');
  });

  it('drops characters XML cannot hold and trims the sheet name', () => {
    const files = unzip(toXlsx(report({ title: 'A/B: ledger [cash] for the whole financial year 2026', rows: [{ cells: ['bell\u0007', null, null, null] }] })));
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('>bell<');
    const name = /name="([^"]*)"/.exec(files.get('xl/workbook.xml')!)![1]!;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[\\/?*[\]:]/);
  });
});
