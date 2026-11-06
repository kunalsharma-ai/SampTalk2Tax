import { describe, expect, it } from 'vitest';
import {
  D,
  DocumentValidationError,
  PostingAccount,
  TaxRateInfo,
  addDays,
  ageingBucket,
  allocationIssues,
  buildDocumentJournal,
  buildPaymentJournal,
  computeDocument,
  documentNumber,
  debitNoteNumber,
  validateJournal,
} from '../src';

const rates = new Map<string, TaxRateInfo>([
  ['t18', { id: 't18', name: 'Tax 18%', rate: '18', accountId: 'tax' }],
  ['t5', { id: 't5', name: 'Tax 5%', rate: '5', accountId: 'tax' }],
  ['noacct', { id: 'noacct', name: 'Broken', rate: '12', accountId: null }],
  ['zero', { id: 'zero', name: 'Exempt', rate: '0', accountId: null }],
]);

const accounts = new Map<string, PostingAccount>(
  ['ar', 'ap', 'rev', 'rev2', 'exp', 'tax', 'bank'].map((id) => [id, { id, code: id, type: id === 'ap' || id === 'tax' ? 'LIABILITY' : id.startsWith('rev') ? 'REVENUE' : id === 'exp' ? 'EXPENSE' : 'ASSET', isPostable: true, isActive: true }]),
);

describe('computeDocument', () => {
  it('rounds each line half-even and totals the rounded lines', () => {
    const d = computeDocument(
      [
        { accountId: 'rev', quantity: '3', unitPrice: '333.335', taxRateId: 't18' },
        { accountId: 'rev2', quantity: '1.5', unitPrice: '100', taxRateId: 't5' },
        { accountId: 'rev', quantity: '1', unitPrice: '50', taxRateId: 'zero' },
      ],
      'INR',
      rates,
    );
    // 3 x 333.335 = 1000.005 -> 1000.00 (half-even); tax 180.00
    expect(d.lines[0].netAmount.toFixed(2)).toBe('1000.00');
    expect(d.lines[0].taxAmount.toFixed(2)).toBe('180.00');
    expect(d.lines[1].netAmount.toFixed(2)).toBe('150.00');
    expect(d.lines[1].taxAmount.toFixed(2)).toBe('7.50');
    expect(d.subtotal.toFixed(2)).toBe('1200.00');
    expect(d.taxTotal.toFixed(2)).toBe('187.50');
    expect(d.total.toFixed(2)).toBe('1387.50');
  });

  it('respects currencies without minor units', () => {
    const d = computeDocument([{ accountId: 'rev', quantity: '1', unitPrice: '1000.5' }], 'JPY', rates);
    expect(d.total.toFixed()).toBe('1000');
  });

  it('collects every problem', () => {
    try {
      computeDocument(
        [
          { accountId: 'rev', quantity: '0', unitPrice: '10' },
          { accountId: 'rev', quantity: '1', unitPrice: '10', taxRateId: 'missing' },
          { accountId: 'rev', quantity: '1', unitPrice: '10', taxRateId: 'noacct' },
        ],
        'INR',
        rates,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentValidationError);
      const issues = (e as DocumentValidationError).issues.join('\n');
      expect(issues).toMatch(/Line 1: quantity/);
      expect(issues).toMatch(/Line 2: tax rate not found/);
      expect(issues).toMatch(/Line 3: tax rate "Broken" has no account/);
    }
  });

  it('refuses a zero total and JS numbers', () => {
    expect(() => computeDocument([{ accountId: 'rev', quantity: '1', unitPrice: '0' }], 'INR', rates)).toThrow(/greater than zero/);
    expect(() => computeDocument([{ accountId: 'rev', quantity: 1 as unknown as string, unitPrice: '1' }], 'INR', rates)).toThrow(/decimal strings/);
  });
});

describe('document journals', () => {
  const doc = computeDocument(
    [
      { accountId: 'rev', quantity: '2', unitPrice: '499.99', taxRateId: 't18' },
      { accountId: 'rev2', quantity: '1', unitPrice: '0.01', taxRateId: 't5' },
    ],
    'INR',
    rates,
  );

  it.each([
    ['INVOICE', 'ar', 'debit'],
    ['CREDIT_NOTE', 'ar', 'credit'],
    ['BILL', 'ap', 'credit'],
    ['VENDOR_CREDIT', 'ap', 'debit'],
  ] as const)('%s balances and puts the total on the %s control account', (kind, control, side) => {
    const lines = buildDocumentJournal(kind, doc, control, 'INR');
    const j = validateJournal(lines, { functionalCurrency: 'INR', accounts });
    expect(j.totalFunctionalDebit.toFixed(2)).toBe(doc.total.toFixed(2));
    expect(lines[0].accountId).toBe(control);
    expect(lines[0][side]).toBe(doc.total.toFixed());
  });

  it('balances for many random documents (property)', () => {
    let s = 7;
    const r = () => (s = (s * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(r() * 6);
      const lines = Array.from({ length: n }, () => ({
        accountId: r() > 0.5 ? 'rev' : 'rev2',
        quantity: (1 + Math.floor(r() * 50000) / 1000).toFixed(3),
        unitPrice: (Math.floor(r() * 10_000_000) / 1000).toFixed(3),
        taxRateId: r() > 0.3 ? (r() > 0.5 ? 't18' : 't5') : null,
      }));
      let d;
      try {
        d = computeDocument(lines, 'INR', rates);
      } catch {
        continue;
      }
      for (const kind of ['INVOICE', 'BILL'] as const) {
        const j = validateJournal(buildDocumentJournal(kind, d, kind === 'INVOICE' ? 'ar' : 'ap', 'INR'), { functionalCurrency: 'INR', accounts });
        expect(j.totalFunctionalDebit.eq(d.total)).toBe(true);
      }
    }
  });

  it('builds receipts and payments', () => {
    expect(buildPaymentJournal('RECEIPT', new D('100.50'), 'bank', 'ar', 'INR')).toEqual([
      { accountId: 'bank', currency: 'INR', debit: '100.5' },
      { accountId: 'ar', currency: 'INR', credit: '100.5' },
    ]);
    expect(buildPaymentJournal('PAYMENT', new D('7'), 'bank', 'ap', 'INR')[0]).toEqual({ accountId: 'ap', currency: 'INR', debit: '7' });
    expect(() => buildPaymentJournal('PAYMENT', new D('0'), 'bank', 'ap', 'INR')).toThrow();
    expect(() => buildPaymentJournal('PAYMENT', new D('1.001'), 'bank', 'ap', 'INR')).toThrow(/decimal places/);
  });
});

describe('ageing and allocation', () => {
  it('buckets by days past due', () => {
    expect(ageingBucket('2026-10-31', '2026-10-31')).toBe('current');
    expect(ageingBucket('2026-10-30', '2026-10-31')).toBe('days1to30');
    expect(ageingBucket('2026-10-01', '2026-10-31')).toBe('days1to30');
    expect(ageingBucket('2026-09-30', '2026-10-31')).toBe('days31to60');
    expect(ageingBucket('2026-08-02', '2026-10-31')).toBe('days61to90');
    expect(ageingBucket('2026-08-01', '2026-10-31')).toBe('over90');
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
  });

  it('refuses over-allocation from either side', () => {
    expect(allocationIssues(new D('50'), new D('100'), new D('60'), 'INR')).toEqual([]);
    expect(allocationIssues(new D('70'), new D('100'), new D('60'), 'INR')[0]).toMatch(/still due/);
    expect(allocationIssues(new D('70'), new D('60'), new D('100'), 'INR')[0]).toMatch(/unallocated/);
    expect(allocationIssues(new D('0.001'), new D('1'), new D('1'), 'INR')[0]).toMatch(/decimal places/);
    expect(allocationIssues(new D('0'), new D('1'), new D('1'), 'INR')[0]).toMatch(/greater than zero/);
  });

  it('numbers documents', () => {
    expect(documentNumber('INVOICE', 12)).toBe('INV-000012');
    expect(documentNumber('RECEIPT', 1)).toBe('RCPT-000001');
    expect(debitNoteNumber(7)).toBe('DN-000007');
  });
});
