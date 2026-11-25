import { describe, expect, it } from 'vitest';
import { gstinCheckCharacter, readReceipt } from '../src';

const GSTIN = `29ABCDE1234F1Z${gstinCheckCharacter('29ABCDE1234F1Z')}`;
const TODAY = '2026-11-25';

describe('readReceipt (EXP-004)', () => {
  it('reads a café bill as OCR returns it', () => {
    const text = [
      'CHAI POINT CAFE',
      '12 MG Road, Bengaluru',
      `GSTIN: ${GSTIN}`,
      'Bill No: 4521',
      'Date: 14/11/2026 13:05',
      'Masala Chai x2 180.00',
      'Veg Sandwich 220.00',
      'Subtotal 400.00',
      'CGST 2.5% 10.00',
      'SGST 2.5% 10.00',
      'TOTAL Rs. 420.00',
      'Paid by UPI',
      'Thank you!',
    ].join('\n');
    const r = readReceipt(text, { today: TODAY });
    expect(r.merchant).toEqual({ value: 'CHAI POINT CAFE', confidence: 'MEDIUM', line: 'CHAI POINT CAFE' });
    expect(r.date).toMatchObject({ value: '2026-11-14', confidence: 'HIGH' });
    expect(r.subtotal?.value).toBe('400.00');
    expect(r.taxes).toEqual([
      { label: 'CGST', rate: '2.5', amount: '10.00', line: 'CGST 2.5% 10.00' },
      { label: 'SGST', rate: '2.5', amount: '10.00', line: 'SGST 2.5% 10.00' },
    ]);
    expect(r.taxTotal).toBe('20.00');
    expect(r.total).toEqual({ value: '420.00', confidence: 'HIGH', line: 'TOTAL Rs. 420.00' });
    expect(r.addsUp).toBe(true);
    expect(r.gstin).toMatchObject({ value: GSTIN, confidence: 'HIGH' });
    expect(r.currency).toBe('INR');
    expect(r.warnings).toEqual([]);
  });

  it('prefers a grand total over a total, reads Indian digit grouping and word dates', () => {
    const r = readReceipt(
      ['*** Hotel Saffron Inn ***', 'Tax Invoice', 'Dated 3rd Nov 2026', 'Room 2 nights 1,12,000.00', 'Total 1,12,000.00', 'IGST @ 18% 20,160.00', 'Grand Total ₹ 1,32,160.00'].join('\n'),
      { today: TODAY },
    );
    expect(r.merchant?.value).toBe('Hotel Saffron Inn');
    expect(r.date?.value).toBe('2026-11-03');
    expect(r.total?.value).toBe('132160.00');
    expect(r.taxes.map((t) => [t.label, t.rate, t.amount])).toEqual([['IGST', '18', '20160.00']]);
  });

  it('says what it is unsure of', () => {
    const r = readReceipt(['Corner Store', '03/04/2026', 'Milk 60', 'Bread 45.5', `GSTIN 29ABCDE1234F1Z${gstinCheckCharacter('29ABCDE1234F1Z') === 'A' ? 'B' : 'A'}`].join('\n'), { today: TODAY });
    expect(r.date).toMatchObject({ value: '2026-04-03', confidence: 'MEDIUM' });
    expect(r.total).toMatchObject({ value: '60.00', confidence: 'LOW' });
    expect(r.gstin?.confidence).toBe('LOW');
    expect(r.warnings).toEqual([
      expect.stringMatching(/^The GSTIN 29ABCDE1234F1Z. does not check out/),
      'The date 03/04/2026 could be read either way; it was read day first',
      'No line says "total"; the largest amount was taken as the total',
    ]);
    // Month first, as in the US.
    expect(readReceipt('Corner Store\n03/04/2026\nTotal $12.40', { today: TODAY, dayFirst: false })).toMatchObject({ date: { value: '2026-03-04' }, total: { value: '12.40' }, currency: 'USD' });
  });

  it('flags a total that the subtotal and tax do not reach, and a date in the future', () => {
    const r = readReceipt(['Paper Mart', 'Date: 2027-01-05', 'Date: 2026-10-01', 'Sub Total 1000.00', 'GST 18% 180.00', 'Amount Payable 1280.00'].join('\n'), { today: TODAY });
    expect(r.date?.value).toBe('2026-10-01');
    expect(r.addsUp).toBe(false);
    expect(r.total).toMatchObject({ value: '1280.00', confidence: 'MEDIUM' });
    expect(r.warnings).toEqual(['The date read (2027-01-05) is after today; check it', 'The subtotal 1000.00 and tax 180.00 do not add up to the total 1280.00; check the total']);
  });

  it('copes with empty and hostile text quickly', () => {
    expect(readReceipt('', { today: TODAY })).toMatchObject({
      merchant: null,
      date: null,
      total: null,
      warnings: ['No amount could be read', 'No date could be read', 'The merchant could not be read'],
    });
    const t = Date.now();
    readReceipt(`${'1,'.repeat(30_000)}\n${'0'.repeat(40_000)}\n${'a '.repeat(20_000)}`, { today: TODAY });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
