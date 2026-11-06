import { dec } from './money';
import { formatAmount, type NumberStyle } from './invoice-templates';

/**
 * Report exports: one tabular model for every financial report, written out as CSV or as an
 * Excel workbook (.xlsx). The API also lays the same model out as a PDF.
 *
 * Amounts stay decimal strings until the last step. CSV keeps them exactly as text; the workbook
 * writes them as numbers (Excel keeps about 15 significant digits, ample for currency amounts)
 * with a number format, so totals can be summed and checked in the spreadsheet.
 */

export type ExportCellType = 'text' | 'money' | 'number' | 'percent' | 'date';
export type ExportRowStyle = 'normal' | 'section' | 'subtotal' | 'total';
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'xlsx', 'pdf'];

export interface ExportColumn {
  label: string;
  type: ExportCellType;
  /** Characters, roughly; used for spreadsheet column widths and PDF layout. */
  width?: number;
}

export interface ExportRow {
  /** One value per column; null = empty. Money and numbers are decimal strings, dates YYYY-MM-DD. */
  cells: (string | null)[];
  style?: ExportRowStyle;
  /** Indent level of the first cell. */
  indent?: number;
  /** Cell types that differ from the column's, such as a margin row in percent under amounts. */
  types?: (ExportCellType | null)[];
}

/** The type of one cell: the row's override, else the column's. */
export function cellType(r: ExportReport, row: ExportRow, j: number): ExportCellType {
  return row.types?.[j] ?? r.columns[j]!.type;
}

export interface ExportReport {
  /** Such as "Trial balance". */
  title: string;
  orgName: string;
  /** Such as "As of 31 Oct 2026" or "1 Apr 2026 to 31 Oct 2026". */
  period: string;
  currency: string;
  /** ISO timestamp the export was made. */
  generatedAt: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  /** Lines printed under the table: checks, filters, explanations. */
  notes: string[];
  /** File name without extension, such as "trial-balance-2026-10-31". */
  fileName: string;
  /** Wide reports print in landscape. */
  landscape?: boolean;
}

export class ReportExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportExportError';
  }
}

/** Checks the model is consistent: every row has one cell per column and numbers parse. */
export function checkExportReport(r: ExportReport): void {
  if (!r.columns.length) throw new ReportExportError('A report needs at least one column');
  r.rows.forEach((row, i) => {
    if (row.cells.length !== r.columns.length) {
      throw new ReportExportError(`Row ${i + 1} has ${row.cells.length} cells for ${r.columns.length} columns`);
    }
    row.cells.forEach((c, j) => {
      const t = cellType(r, row, j);
      if (c === null || c === '') return;
      if ((t === 'money' || t === 'number' || t === 'percent') && !/^-?\d+(\.\d+)?$/.test(c)) {
        throw new ReportExportError(`Row ${i + 1}, ${r.columns[j]!.label}: "${c}" is not a number`);
      }
      if (t === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(c)) throw new ReportExportError(`Row ${i + 1}, ${r.columns[j]!.label}: "${c}" is not a date`);
    });
  });
}

export function exportFileName(r: ExportReport, format: ExportFormat): string {
  const safe = r.fileName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
  return `${safe}.${format}`;
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * A text cell that a spreadsheet would read as a formula (=, +, -, @, tab, carriage return) is
 * prefixed with an apostrophe, so a contact called "=HYPERLINK(...)" stays text (CSV injection).
 */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * RFC 4180 CSV with a UTF-8 byte order mark (so Excel reads non-English names), CRLF line ends,
 * a header row, and amounts as plain decimals ("-1234.50") that any program can parse.
 * The title, organisation and period come first, then a blank line, then the table.
 */
export function toCsv(r: ExportReport): string {
  checkExportReport(r);
  const lines: string[] = [];
  const text = (s: string) => csvField(neutraliseFormula(s));
  lines.push(text(r.title));
  lines.push(text(r.orgName));
  lines.push(text(`${r.period} · ${r.currency}`));
  lines.push('');
  lines.push(r.columns.map((c) => text(c.label)).join(','));
  for (const row of r.rows) {
    lines.push(
      row.cells
        .map((c, j) => {
          if (c === null) return '';
          const t = cellType(r, row, j);
          if (t === 'text') return text(j === 0 && row.indent ? `${'  '.repeat(row.indent)}${c}` : c);
          return csvField(c);
        })
        .join(','),
    );
  }
  if (r.notes.length) {
    lines.push('');
    for (const n of r.notes) lines.push(text(n));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------------------------
// XLSX (Office Open XML spreadsheet), written without dependencies
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      cp = Math.min(cp, 0x10ffff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return Uint8Array.from(out);
}

/** A ZIP archive with stored (uncompressed) entries, which every spreadsheet program reads. */
export function zipStore(files: { name: string; data: Uint8Array }[], date = new Date(Date.UTC(2026, 0, 1))): Uint8Array {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of all) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

function xml(s: string): string {
  // Characters XML 1.0 does not allow are dropped.
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Days since 1899-12-30, Excel's date serial. */
export function excelDate(iso: string): number {
  return Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// Style indexes into cellXfs below.
const S = { text: 0, bold: 1, money: 2, moneyBold: 3, title: 4, date: 5, header: 6, muted: 7, number: 8, numberBold: 9, percent: 10, percentBold: 11, section: 12 };
/** Style of an amount cell: band 0 uses money / moneyBold, later bands the pairs from 13. */
const moneyStyle = (band: number, bold: boolean) => (band === 0 ? (bold ? S.moneyBold : S.money) : 13 + (band - 1) * 2 + (bold ? 1 : 0));

const MONEY_BANDS = 6;
/** Header cell over a numeric column, right aligned; the last cellXfs entry. */
const HEADER_RIGHT = 13 + (MONEY_BANDS - 1) * 2;

/**
 * Number formats for amounts, by size. Excel and LibreOffice treat conditional formats
 * differently for negative numbers, so Indian lakh and crore grouping uses a plain two-section
 * format per size band and each cell picks its band: band 0 is below one lakh, band k adds one
 * more two-digit group (below 1 crore, 100 crore, 1 lakh crore, ...). The last band takes
 * everything larger. With thousands grouping every band is the same format.
 */
function moneyFormats(style: NumberStyle): string[] {
  if (style !== 'INDIAN') return Array(MONEY_BANDS).fill('#,##0.00;-#,##0.00');
  return Array.from({ length: MONEY_BANDS }, (_, k) => {
    const f = k === 0 ? '#,##0.00' : `${'##\\,'.repeat(k + 1)}##0.00`;
    return `${f};-${f}`;
  });
}

function moneyBand(abs: ReturnType<typeof dec>): number {
  let band = 0;
  for (let limit = dec('100000'); band < MONEY_BANDS - 1 && abs.gte(limit); limit = limit.mul(100)) band++;
  return band;
}

function stylesXml(style: NumberStyle): string {
  const f = moneyFormats(style);
  const bands = Array.from({ length: MONEY_BANDS - 1 }, (_, j) => j + 1)
    .map((i) => `<xf numFmtId="${166 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="${166 + i}" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${MONEY_BANDS + 2}"><numFmt numFmtId="164" formatCode="${f[0]}"/>${f.slice(1).map((x, j) => `<numFmt numFmtId="${167 + j}" formatCode="${x}"/>`).join('')}<numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy"/><numFmt numFmtId="166" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA5B1"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF333333"/></top><bottom style="double"><color rgb="FF333333"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${14 + (MONEY_BANDS - 1) * 2}">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
${bands}
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/**
 * An Excel workbook with one sheet: title, organisation and period, a frozen header row, the
 * table with amounts as numbers in a currency format (lakh grouping for INR), subtotals and
 * totals in bold with rules, and the notes underneath.
 */
export function toXlsx(r: ExportReport, opts: { numberStyle?: NumberStyle } = {}): Uint8Array {
  checkExportReport(r);
  const numberStyle = opts.numberStyle ?? (r.currency === 'INR' ? 'INDIAN' : 'INTERNATIONAL');
  const rowsXml: string[] = [];
  let rn = 0;
  const inline = (ref: string, s: number, text: string) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  const textRow = (s: number, text: string) => {
    rn++;
    rowsXml.push(`<row r="${rn}">${inline(`A${rn}`, s, text)}</row>`);
  };
  textRow(S.title, r.title);
  textRow(S.section, r.orgName);
  textRow(S.muted, `${r.period} · Amounts in ${r.currency}`);
  rn++;
  rn++;
  const headerRow = rn;
  rowsXml.push(`<row r="${rn}">${r.columns.map((c, j) => inline(`${colName(j)}${rn}`, c.type === 'text' || c.type === 'date' ? S.header : HEADER_RIGHT, c.label)).join('')}</row>`);
  for (const row of r.rows) {
    rn++;
    const strong = row.style === 'subtotal' || row.style === 'total';
    const cells = row.cells
      .map((v, j) => {
        const ref = `${colName(j)}${rn}`;
        if (v === null || v === '') return strong || row.style === 'section' ? `<c r="${ref}" s="${strong ? S.bold : S.section}"/>` : '';
        const t = cellType(r, row, j);
        if (t === 'money') {
          const n = dec(v);
          const s = moneyStyle(moneyBand(n.abs()), strong);
          return `<c r="${ref}" s="${s}"><v>${n.toString()}</v></c>`;
        }
        if (t === 'number') return `<c r="${ref}" s="${strong ? S.numberBold : S.number}"><v>${dec(v).toString()}</v></c>`;
        if (t === 'percent') return `<c r="${ref}" s="${strong ? S.percentBold : S.percent}"><v>${dec(v).toString()}</v></c>`;
        if (t === 'date') return `<c r="${ref}" s="${S.date}"><v>${excelDate(v)}</v></c>`;
        const label = j === 0 && row.indent ? `${'    '.repeat(row.indent)}${v}` : v;
        return inline(ref, strong ? S.bold : row.style === 'section' ? S.section : S.text, label);
      })
      .join('');
    rowsXml.push(`<row r="${rn}">${cells}</row>`);
  }
  if (r.notes.length) {
    rn++;
    for (const n of r.notes) textRow(S.muted, n);
  }
  textRow(S.muted, `Exported ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC from Talk2Tax`);
  const cols = r.columns
    .map((c, j) => `<col min="${j + 1}" max="${j + 1}" width="${Math.max(8, Math.min(60, c.width ?? (c.type === 'text' ? 28 : 16)))}" customWidth="1"/>`)
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="${r.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
  const sheetName = xml(r.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const files = [
    {
      name: '[Content_Types].xml',
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    },
    {
      name: '_rels/.rels',
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    },
    {
      name: 'docProps/core.xml',
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(r.title)}</dc:title><dc:creator>Talk2Tax</dc:creator><dc:description>${xml(`${r.orgName}, ${r.period}`)}</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${xml(r.generatedAt.slice(0, 19))}Z</dcterms:created></cp:coreProperties>`),
    },
    {
      name: 'xl/workbook.xml',
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName || 'Report'}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    { name: 'xl/styles.xml', data: utf8(stylesXml(numberStyle)) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheet) },
  ];
  return zipStore(files, new Date(r.generatedAt));
}

/** Amount text for the PDF and for screens: grouped, at two decimals, minus sign in front. */
export function exportAmount(value: string, currency: string, style?: NumberStyle): string {
  return formatAmount(value, currency, style ?? (currency === 'INR' ? 'INDIAN' : 'INTERNATIONAL'));
}
