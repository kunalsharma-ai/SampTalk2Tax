import { describe, expect, it } from 'vitest';
import { checkInvoiceContent, eInvoicingOutlook, eInvoicingRule, invoiceFormatRule, invoiceFormatTier, INVOICE_FORMAT_RULES, type InvoiceContentFacts } from '../src/invoice-rules';

const facts = (over: Partial<InvoiceContentFacts> = {}): InvoiceContentFacts => ({
  grossLocal: '1200',
  numbered: true,
  title: 'Invoice',
  sellerTaxNumber: 'GB123456789',
  sellerAddress: true,
  buyerName: 'Acme Ltd',
  buyerAddress: true,
  buyerTaxNumber: null,
  reverseCharge: false,
  interstate: false,
  placeOfSupply: null,
  lines: [{ description: 'Consulting', quantity: '1', taxRateChosen: true, hsnCode: null }],
  ...over,
});

describe('invoice format rules (TAX-039)', () => {
  it('covers each VAT and GST module with a source', () => {
    expect(INVOICE_FORMAT_RULES.map((r) => r.country).sort()).toEqual(['AE', 'AU', 'CA', 'DE', 'GB', 'IN', 'SG']);
    for (const r of INVOICE_FORMAT_RULES) expect(r.source.length).toBeGreaterThan(10);
    expect(invoiceFormatRule('us')).toBeNull();
  });

  it('picks the simplified UK invoice up to £250 and the full one above', () => {
    const gb = invoiceFormatRule('GB')!;
    expect(invoiceFormatTier(gb, '250', false).name).toBe('Simplified VAT invoice');
    expect(invoiceFormatTier(gb, '250.01', false).name).toBe('Full VAT invoice');
    const small = checkInvoiceContent(gb, facts({ grossLocal: '100', buyerAddress: false }));
    expect(small.gaps).toEqual([]);
    const full = checkInvoiceContent(gb, facts({ buyerAddress: false, sellerTaxNumber: null }));
    expect(full.gaps.map((g) => g.key)).toEqual(['SELLER_TAX_NUMBER', 'BUYER_ADDRESS']);
  });

  it('names the lines that are missing descriptions, quantities and rates', () => {
    const de = invoiceFormatRule('DE')!;
    const res = checkInvoiceContent(
      de,
      facts({
        lines: [
          { description: 'A', quantity: '1', taxRateChosen: true, hsnCode: null },
          { description: ' ', quantity: '0', taxRateChosen: false, hsnCode: null },
        ],
      }),
    );
    expect(res.gaps.find((g) => g.key === 'DESCRIPTIONS')?.lines).toEqual([2]);
    expect(res.gaps.find((g) => g.key === 'QUANTITIES')?.lines).toEqual([2]);
    expect(res.gaps.find((g) => g.key === 'TAX_RATES')?.lines).toEqual([2]);
  });

  it('asks for the customer VAT number on a German reverse-charge invoice', () => {
    const de = invoiceFormatRule('DE')!;
    expect(checkInvoiceContent(de, facts({ reverseCharge: true })).gaps.map((g) => g.key)).toEqual(['BUYER_TAX_NUMBER']);
  });

  it('uses the full UAE tax invoice only for registered customers above AED 10,000', () => {
    const ae = invoiceFormatRule('AE')!;
    expect(invoiceFormatTier(ae, '20000', false).name).toBe('Simplified tax invoice');
    expect(invoiceFormatTier(ae, '20000', true).name).toBe('Tax invoice');
    expect(invoiceFormatTier(ae, '10000', true).name).toBe('Simplified tax invoice');
    expect(checkInvoiceContent(ae, facts({ grossLocal: '500' })).gaps.map((g) => g.key)).toEqual(['TITLE']);
    expect(checkInvoiceContent(ae, facts({ grossLocal: '500', title: 'TAX INVOICE | فاتورة ضريبية' })).gaps).toEqual([]);
  });

  it('steps up Canadian requirements at $30 and $150', () => {
    const ca = invoiceFormatRule('CA')!;
    expect(invoiceFormatTier(ca, '29.99', false).name).toBe('Receipt (under $30)');
    expect(invoiceFormatTier(ca, '30', false).name).toBe('Invoice ($30 to $149.99)');
    expect(invoiceFormatTier(ca, '150', false).name).toBe('Invoice ($150 or more)');
    expect(checkInvoiceContent(ca, facts({ grossLocal: '20', sellerTaxNumber: null })).gaps).toEqual([]);
    expect(checkInvoiceContent(ca, facts({ grossLocal: '40', sellerTaxNumber: null })).gaps.map((g) => g.key)).toEqual(['SELLER_TAX_NUMBER']);
  });

  it('applies Indian HSN and buyer details to registered customers and place of supply to interstate sales', () => {
    const india = invoiceFormatRule('IN')!;
    const b2c = checkInvoiceContent(india, facts({ title: 'Tax Invoice', grossLocal: '1000', buyerAddress: false }));
    expect(b2c.gaps).toEqual([]);
    const b2b = checkInvoiceContent(india, facts({ title: 'Tax Invoice', buyerTaxNumber: '27AAACY1234F1Z5', buyerAddress: false, interstate: true }));
    expect(b2b.gaps.map((g) => g.key)).toEqual(['BUYER_ADDRESS', 'HSN_CODES', 'PLACE_OF_SUPPLY']);
    const big = checkInvoiceContent(india, facts({ title: 'Tax Invoice', grossLocal: '50000', buyerAddress: false }));
    expect(big.gaps.map((g) => g.key)).toEqual(['BUYER_ADDRESS', 'PLACE_OF_SUPPLY']);
  });
});

describe('e-invoicing requirements (TAX-040)', () => {
  it('Germany: receive now, issue from 2027 above €800,000, everyone from 2028', () => {
    const de = eInvoicingRule('DE')!;
    const big = eInvoicingOutlook(de, { today: '2026-11-24', turnover: '900000' });
    expect(big.verdict).toBe('WILL_HAVE_TO_ISSUE');
    expect(big.nextFrom).toBe('2027-01-01');
    expect(big.mustReceive).toBe(true);
    expect(eInvoicingOutlook(de, { today: '2026-11-24', turnover: '800000' }).nextFrom).toBe('2028-01-01');
    expect(eInvoicingOutlook(de, { today: '2028-02-01', turnover: '1' }).verdict).toBe('MUST_ISSUE');
  });

  it('India: IRN required above Rs 5 crore, from the earliest phase that fits', () => {
    const india = eInvoicingRule('IN')!;
    expect(eInvoicingOutlook(india, { today: '2026-11-24', turnover: '60000000' }).since).toBe('2023-08-01');
    expect(eInvoicingOutlook(india, { today: '2026-11-24', turnover: '6000000000' }).since).toBe('2020-10-01');
    expect(eInvoicingOutlook(india, { today: '2026-11-24', turnover: '50000000' }).verdict).toBe('NOT_REQUIRED');
    expect(eInvoicingOutlook(india, { today: '2026-11-24', turnover: null }).verdict).toBe('CHECK');
  });

  it('UAE: AED 50 million splits January and July 2027', () => {
    const ae = eInvoicingRule('AE')!;
    expect(eInvoicingOutlook(ae, { today: '2026-11-24', turnover: '50000000' }).nextFrom).toBe('2027-01-01');
    expect(eInvoicingOutlook(ae, { today: '2026-11-24', turnover: '49999999' }).nextFrom).toBe('2027-07-01');
  });

  it('Singapore depends on registration facts; Australia and Canada need nothing', () => {
    expect(eInvoicingOutlook(eInvoicingRule('SG')!, { today: '2026-11-24', turnover: null }).verdict).toBe('CHECK');
    expect(eInvoicingOutlook(eInvoicingRule('AU')!, { today: '2026-11-24', turnover: null }).verdict).toBe('NOT_REQUIRED');
    expect(eInvoicingOutlook(eInvoicingRule('CA')!, { today: '2026-11-24', turnover: '1' }).verdict).toBe('NOT_REQUIRED');
    expect(eInvoicingOutlook(eInvoicingRule('GB')!, { today: '2026-11-24', turnover: null }).nextFrom).toBe('2029-04-01');
  });
});
