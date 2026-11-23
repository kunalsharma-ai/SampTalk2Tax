import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractBill, pdfText, readAmount, readDate } from '../src';

const inflate = (d: Uint8Array) => inflateSync(d, { maxOutputLength: 50_000_000 });
const ctx = { vendors: [{ id: 'v1', name: 'Granite Parts Private Limited', taxId: '27AAACG1234F1Z4' }, { id: 'v2', name: 'Northwind Cloud LLP', taxId: null }], ownTaxIds: ['29AABCT5678K1ZN'], currency: 'INR', today: '2026-11-23' };

/** A PDF built by hand: objects as written, streams compressed when asked. */
function pdf(objects: (string | undefined | { dict: string; stream: string; compress?: boolean })[]) {
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objects.forEach((o, i) => {
    if (o === undefined) return; // a number kept free for an object inside an object stream
    if (typeof o === 'string') parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else {
      const data = o.compress ? deflateSync(Buffer.from(o.stream, 'latin1')) : Buffer.from(o.stream, 'latin1');
      parts.push(Buffer.from(`${i + 1} 0 obj\n<< ${o.dict}${o.compress ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    }
  });
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

const SAMPLE = [
  'Granite Parts Pvt Ltd   TAX INVOICE',
  'GSTIN: 27AAACG1234F1Z4',
  'Bill to: Talk Traders   GSTIN 29AABCT5678K1ZN',
  'Invoice No: GP/2026/118',
  'Invoice Date: 05/10/2026',
  'Due Date: 04/11/2026',
  'S.No   Description   HSN   Qty   Rate   Amount',
  '1   Steel brackets   7326   10 Nos   450.00   4,500.00',
  '2   Fitting service   9987   2   1,250.00   2,500.00',
  '    for the Pune plant',
  'Sub Total   7,000.00',
  'CGST @ 9%   630.00',
  'SGST @ 9%   630.00',
  'Grand Total   Rs. 8,260.00',
  'Amount in words: Rupees Eight Thousand Two Hundred Sixty only',
].join('\n');

describe('reading amounts and dates', () => {
  it('reads amounts as bills write them', () => {
    expect(readAmount('1,23,456.78')!.toFixed(2)).toBe('123456.78');
    expect(readAmount('Rs.450')!.toFixed(2)).toBe('450.00');
    expect(readAmount('₹8,260.00')!.toFixed(2)).toBe('8260.00');
    expect(readAmount('500/-')!.toFixed(2)).toBe('500.00');
    expect(readAmount('-0.40')!.toFixed(2)).toBe('-0.40');
    expect(readAmount('(12.00)')!.toFixed(2)).toBe('-12.00');
    for (const bad of ['GP/2026', '1.2.3', ',100', '12,', 'abc', '05/10/2026', '1.23456']) expect(readAmount(bad)).toBeNull();
  });
  it('reads dates, day before month', () => {
    expect(readDate('05/10/2026')).toBe('2026-10-05');
    expect(readDate('on 5-10-26')).toBe('2026-10-05');
    expect(readDate('2026-10-05')).toBe('2026-10-05');
    expect(readDate('05.10.2026')).toBe('2026-10-05');
    expect(readDate('5 Oct 2026')).toBe('2026-10-05');
    expect(readDate('05-Oct-2026')).toBe('2026-10-05');
    expect(readDate('October 5, 2026')).toBe('2026-10-05');
    expect(readDate('5th October 2026')).toBe('2026-10-05');
    expect(readDate('31/02/2026')).toBeNull();
    expect(readDate('no date here 12')).toBeNull();
  });
});

describe('reading a bill', () => {
  it('reads a GST tax invoice: supplier by GSTIN, number, dates, items, taxes and total', () => {
    const b = extractBill(SAMPLE, ctx);
    expect(b.supplier).toEqual({ name: 'Granite Parts Private Limited', taxId: '27AAACG1234F1Z4', contactId: 'v1', matchedBy: 'TAX_ID', source: 'FOUND' });
    expect(b.buyerTaxId).toBe('29AABCT5678K1ZN');
    expect(b.invoiceNumber).toEqual({ value: 'GP/2026/118', source: 'FOUND' });
    expect(b.issueDate).toEqual({ value: '2026-10-05', source: 'FOUND' });
    expect(b.dueDate).toEqual({ value: '2026-11-04', source: 'FOUND' });
    expect(b.currency).toEqual({ value: 'INR', source: 'FOUND' });
    expect(b.linesFrom).toBe('TABLE');
    expect(b.lines).toEqual([
      { description: 'Steel brackets', hsnCode: '7326', quantity: '10', unitPrice: '450.00', amount: '4500.00', sourceLine: 8 },
      { description: 'Fitting service for the Pune plant', hsnCode: '9987', quantity: '2', unitPrice: '1250.00', amount: '2500.00', sourceLine: 9 },
    ]);
    expect(b.subtotal).toBe('7000.00');
    expect(b.taxes).toEqual([
      { label: 'CGST', rate: '9', amount: '630.00' },
      { label: 'SGST', rate: '9', amount: '630.00' },
    ]);
    expect(b.taxTotal).toBe('1260.00');
    expect(b.total).toBe('8260.00');
    expect(b.taxPercent).toEqual({ value: '18', source: 'FOUND' });
    expect(b.checks).toEqual([]);
  });

  it('reads terms, IGST, rounding and a supplier by name', () => {
    const b = extractBill(
      [
        'NORTHWIND CLOUD LLP',
        'Invoice # NW-2041',
        'Date: 5 Oct 2026',
        'Payment terms: Net 30',
        'Item   Hours   Price   Total',
        'Cloud hosting October   1   999.50   999.50',
        'Support retainer   3   500.00   1,500.00',
        'Taxable Value   2,499.50',
        'IGST 18%   449.91',
        'Round off   0.59',
        'Total Amount Payable   ₹ 2,950.00',
      ].join('\n'),
      ctx,
    );
    expect(b.supplier).toMatchObject({ contactId: 'v2', matchedBy: 'NAME', taxId: null });
    expect(b.invoiceNumber.value).toBe('NW-2041');
    expect(b.issueDate).toEqual({ value: '2026-10-05', source: 'GUESSED' });
    expect(b.dueDate).toEqual({ value: '2026-11-04', source: 'GUESSED' });
    expect(b.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.amount])).toEqual([
      ['Cloud hosting October', '1', '999.50', '999.50'],
      ['Support retainer', '3', '500.00', '1500.00'],
    ]);
    expect(b).toMatchObject({ subtotal: '2499.50', taxTotal: '449.91', rounding: '0.59', total: '2950.00', taxPercent: { value: '18', source: 'FOUND' } });
    expect(b.checks).toEqual([]);
  });

  it('uses the amount before tax when there is no table, in the currency shown', () => {
    const b = extractBill(['Acme Software Inc', 'Invoice #INV-77', 'Invoice date: Oct 12, 2026', 'Amount due   $ 500.00'].join('\n'), { ...ctx, vendors: [] });
    expect(b.supplier).toMatchObject({ name: 'Acme Software Inc', contactId: null, source: 'GUESSED' });
    expect(b.currency).toEqual({ value: 'USD', source: 'FOUND' });
    expect(b.linesFrom).toBe('TOTAL_ONLY');
    expect(b.lines).toEqual([{ description: 'Bill INV-77', hsnCode: null, quantity: '1', unitPrice: '500.00', amount: '500.00', sourceLine: 0 }]);
    expect(b.taxPercent.source).toBe('MISSING');
    expect(b.checks).toEqual(['No table of items was found; one line for the amount before tax was used. Split it if the bill covers several things', 'Acme Software Inc is not one of your vendors yet; choose the vendor or add them first']);
  });

  it('says in words where the bill does not add up or is incomplete', () => {
    const b = extractBill(SAMPLE.replace('Grand Total   Rs. 8,260.00', 'Grand Total   Rs. 8,300.00').replace('Sub Total   7,000.00', 'Sub Total   7,100.00').replace('Due Date: 04/11/2026', 'Due Date: 01/10/2026'), ctx);
    expect(b.checks).toEqual([
      'The due date 2026-10-01 is before the bill date 2026-10-05',
      "The items add up to 7000.00, but the bill's subtotal is 7100.00; check the items",
      "The subtotal plus tax comes to 8360.00, but the bill's total is 8300.00",
    ]);
    const empty = extractBill('Thank you for your business', ctx);
    expect(empty.linesFrom).toBe('NONE');
    expect(empty.checks).toContain("The bill number could not be found; enter the supplier's bill number");
    expect(empty.checks).toContain('The bill date could not be found; enter it');
    expect(empty.checks).toContain("The bill's total could not be found; check the amounts against the bill");
    const future = extractBill(SAMPLE.replace('Invoice Date: 05/10/2026', 'Invoice Date: 05/12/2026').replace('Due Date: 04/11/2026', 'Due Date: 04/01/2027'), ctx);
    expect(future.checks).toEqual(['The bill date 2026-12-05 is in the future; check it']);
    const other = extractBill(SAMPLE.replace('GSTIN: 27AAACG1234F1Z4', 'GSTIN: 27AAACR4849R1ZL'), ctx);
    expect(other.supplier).toMatchObject({ contactId: 'v1', matchedBy: 'NAME', taxId: '27AAACR4849R1ZL' });
    expect(other.checks).toEqual(['The bill shows GSTIN 27AAACR4849R1ZL, but Granite Parts Private Limited is recorded with 27AAACG1234F1Z4']);
  });

  it('reads long text quickly and never runs away on odd input', () => {
    const t0 = Date.now();
    extractBill(`${'1,'.repeat(50_000)}\n${' '.repeat(50_000)}x\n${'Invoice No '.repeat(5000)}`, ctx);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('reading the text of a PDF', () => {
  it('reads plain content with literal strings, escapes and line moves', () => {
    const r = pdfText(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        { dict: '', stream: 'BT /F1 12 Tf 14 TL 50 700 Td (Granite \\(Parts\\)) Tj T* (Invoice No: GP-7) Tj 0 -14 Td [(Tot) -50 (al) -400 (500.00)] TJ ET' },
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ]),
      inflate,
    );
    expect(r).toEqual({ text: 'Granite (Parts)\nInvoice No: GP-7\nTotal 500.00', pages: 1, problem: null });
  });

  it('reads compressed content, a ToUnicode map for two-byte fonts and objects inside an object stream, top to bottom', () => {
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0041> <0002> <20B9> endbfchar 1 beginbfrange <0010> <0019> <0030> endbfrange endcmap end end';
    // "A" then "₹" then "123" written as glyph codes; the second line is drawn first but sits lower on the page
    const content = 'BT /F2 10 Tf 1 0 0 1 300 600 Tm <0011001200130010> Tj ET BT /F2 10 Tf 1 0 0 1 50 700 Tm <00010002> Tj ET';
    // object 5 (the font) lives inside the object stream, object 7
    const inner = '5 0 ';
    const objstm = `${inner}<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>`;
    const r = pdfText(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F2 5 0 R >> >> >>',
        '<< /Type /Page /Parent 2 0 R /Contents [4 0 R] >>',
        { dict: '', stream: content, compress: true },
        undefined,
        { dict: '', stream: cmap, compress: true },
        { dict: `/Type /ObjStm /N 1 /First ${inner.length}`, stream: objstm, compress: true },
      ]),
      inflate,
    );
    expect(r.problem).toBeNull();
    expect(r.text).toBe('A₹\n1230');
  });

  it('says so when there is no text to read, and refuses what is not a readable PDF', () => {
    const scan = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', { dict: '', stream: 'q 500 0 0 700 0 0 cm /Im1 Do Q' }]);
    expect(pdfText(scan, inflate)).toEqual({ text: '', pages: 1, problem: 'This PDF has no text to read; it is probably a scan or a photo. Paste the text of the bill, or enter the bill by hand' });
    expect(pdfText(new TextEncoder().encode('hello'), inflate).problem).toBe('This is not a PDF file');
    const locked = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard /V 2 >>']);
    const withEncrypt = new Uint8Array([...locked, ...new TextEncoder().encode('trailer << /Encrypt 3 0 R >>')]);
    expect(pdfText(withEncrypt, inflate).problem).toMatch(/password-protected/);
    const broken = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', { dict: '', stream: 'not deflated', compress: false }]);
    expect(pdfText(broken, inflate).text).toBe('');
  });
});
