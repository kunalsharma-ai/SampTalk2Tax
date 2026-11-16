import { cellType, dec, exportAmount, formatDate, type ExportReport, type NumberStyle } from '@talk2tax/accounting-engine';
import PDFDocument from 'pdfkit';

/**
 * Lays an export report out as an A4 PDF with pdfkit: title block, a table that repeats its
 * header on every page, bold subtotals and totals with rules, notes, and a footer with page
 * numbers. Uses the PDF standard fonts (Helvetica), which hold Western European characters
 * only; anything else is printed as "?" (see KNOWN_LIMITATIONS).
 */

const MARGIN = 40;
const ROW_H = 15;
const FONT = 8.5;
const MUTED = '#555f6b';
const RULE = '#9aa5b1';
const HEADER_FILL = '#e8eef7';
/** Characters outside Latin-1 that the standard fonts' WinAnsi encoding still has. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a) out += ' ';
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    else out += cp <= 0xff || WIN_ANSI_EXTRA.has(ch) ? ch : '?';
  }
  return out;
}

function cellText(value: string | null, type: string, currency: string, style: NumberStyle): string {
  if (value === null || value === '') return '';
  if (type === 'money') return exportAmount(value, currency, style);
  if (type === 'number') return dec(value).toString();
  if (type === 'percent') return `${value}%`;
  if (type === 'date') return formatDate(value, 'DMY');
  return value;
}

export function renderReportPdf(r: ExportReport, opts: { numberStyle?: NumberStyle } = {}): Promise<Buffer> {
  const style = opts.numberStyle ?? (r.currency === 'INR' ? 'INDIAN' : 'INTERNATIONAL');
  const created = new Date(r.generatedAt);
  const doc = new PDFDocument({
    size: 'A4',
    layout: r.landscape ? 'landscape' : 'portrait',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: pdfText(r.title), Author: pdfText(r.orgName), Subject: pdfText(`${r.title}, ${r.period}`), Creator: 'Talk2Tax', Producer: 'Talk2Tax', CreationDate: created, ModDate: created },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - 18; // room for the footer

  // Column widths in proportion to the hints, so the table always fits the page width.
  const hints = r.columns.map((c) => c.width ?? (c.type === 'text' ? 28 : 14));
  const sum = hints.reduce((a, b) => a + b, 0);
  const widths = hints.map((h) => (h / sum) * width);
  const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const numeric = r.columns.map((c) => c.type !== 'text' && c.type !== 'date');
  // A cell aligns with its column; only its formatting follows its own type.

  const fit = (text: string, w: number): string => {
    const max = w - 6;
    if (doc.widthOfString(text) <= max) return text;
    let t = text;
    while (t.length > 1 && doc.widthOfString(`${t}…`) > max) t = t.slice(0, -1);
    return `${t}…`;
  };
  const cell = (text: string, i: number, y: number, indent = 0) => {
    const pad = 3 + indent * 8;
    const t = fit(pdfText(text), widths[i]! - indent * 8);
    doc.text(t, xs[i]! + pad, y + 4, { width: widths[i]! - pad - 3, align: numeric[i] ? 'right' : 'left', lineBreak: false });
  };

  let y = MARGIN;
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#111111').text(pdfText(r.title), left, y, { width, lineBreak: false });
  y += 20;
  doc.font('Helvetica-Bold').fontSize(10).text(pdfText(r.orgName), left, y, { width, lineBreak: false });
  y += 14;
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfText(`${r.period} · Amounts in ${r.currency}`), left, y, { width, lineBreak: false });
  y += 20;

  const header = () => {
    doc.rect(left, y, width, ROW_H + 2).fill(HEADER_FILL);
    doc.font('Helvetica-Bold').fontSize(FONT).fillColor('#111111');
    r.columns.forEach((c, i) => cell(c.label, i, y + 1));
    doc.moveTo(left, y + ROW_H + 2).lineTo(left + width, y + ROW_H + 2).lineWidth(0.6).strokeColor(RULE).stroke();
    y += ROW_H + 4;
  };
  header();

  for (const row of r.rows) {
    if (y + ROW_H > bottom()) {
      doc.addPage();
      y = MARGIN;
      header();
    }
    const strong = row.style === 'subtotal' || row.style === 'total' || row.style === 'section';
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT).fillColor('#111111');
    if (row.style === 'subtotal' || row.style === 'total') {
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor('#333333').stroke();
    }
    row.cells.forEach((v, i) => cell(cellText(v, cellType(r, row, i), r.currency, style), i, y, i === 0 ? (row.indent ?? 0) : 0));
    y += ROW_H;
    if (row.style === 'total') {
      doc.moveTo(left, y).lineTo(left + width, y).moveTo(left, y + 2).lineTo(left + width, y + 2).lineWidth(0.5).strokeColor('#333333').stroke();
      y += 4;
    }
  }

  if (r.notes.length) {
    y += 8;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    for (const n of r.notes) {
      const h = doc.heightOfString(pdfText(n), { width });
      if (y + h > bottom()) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(pdfText(n), left, y, { width });
      y += h + 3;
    }
  }

  const range = doc.bufferedPageRange();
  const stamp = `Exported ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC from Talk2Tax`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - MARGIN - 8;
    // Writing below the bottom margin would add a page; lift the margin while writing the footer.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(pdfText(`${r.orgName} · ${r.title} · ${r.period}`), left, fy, { width: width * 0.6, lineBreak: false });
    doc.text(`${stamp} · Page ${i + 1} of ${range.count}`, left + width * 0.4, fy, { width: width * 0.6, align: 'right', lineBreak: false });
    doc.page.margins.bottom = MARGIN;
  }
  doc.end();
  return done;
}
