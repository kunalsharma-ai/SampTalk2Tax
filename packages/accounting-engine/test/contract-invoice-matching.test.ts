import { describe, expect, it } from 'vitest';
import { descriptionSimilarity, matchInvoicesToContracts, periodContaining, type MatchContract, type MatchInvoice } from '../src/contract-invoice-matching';

const contract = (over: Partial<MatchContract> = {}): MatchContract => ({
  id: 'c1',
  ref: 'CT-0001',
  title: 'Annual support',
  contactId: 'cust',
  currency: 'INR',
  start: '2026-01-01',
  end: '2026-12-31',
  frequency: 'MONTHLY',
  timing: 'ADVANCE',
  billingDay: null,
  nextNo: 4,
  subtotal: '15000.00',
  lines: [
    { description: 'Managed support retainer', accountId: 'inc', quantity: '1', unitPrice: '10000.00' },
    { description: 'Cloud hosting', accountId: 'host', quantity: '2', unitPrice: '2500.00' },
  ],
  periods: new Map([
    [1, { status: 'BILLED' as const, documentId: 'd1', documentNumber: 'INV-000001' }],
    [2, { status: 'BILLED' as const, documentId: 'd2', documentNumber: 'INV-000002' }],
    [3, { status: 'SKIPPED' as const, documentId: null, documentNumber: null }],
  ]),
  ...over,
});
const invoice = (over: Partial<MatchInvoice> = {}): MatchInvoice => ({
  id: 'i1',
  number: 'INV-000010',
  contactId: 'cust',
  currency: 'INR',
  issueDate: '2026-04-05',
  subtotal: '15000.00',
  lines: [
    { description: 'Support retainer (managed)', accountId: 'inc', quantity: '1', unitPrice: '10000.00' },
    { description: 'Hosting on cloud', accountId: 'host', quantity: '2', unitPrice: '2500.00' },
  ],
  ...over,
});

describe('contract-to-invoice matching', () => {
  it('compares descriptions by shared words', () => {
    expect(descriptionSimilarity('Managed support retainer', 'Support retainer (managed)')).toBe(1);
    expect(descriptionSimilarity('Cloud hosting', 'Consulting')).toBe(0);
    expect(descriptionSimilarity(null, null)).toBe(1);
  });

  it('finds the period containing a date, and none outside the term', () => {
    expect(periodContaining(contract(), '2026-04-05')).toMatchObject({ no: 4, start: '2026-04-01', end: '2026-04-30' });
    expect(periodContaining(contract(), '2027-01-02')).toBeNull();
    expect(periodContaining(contract(), '2025-12-31')).toBeNull();
  });

  it('suggests counting a hand-made invoice as the next period', () => {
    const [m] = matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice()] });
    expect(m).toMatchObject({ confidence: 'HIGH', score: 100, periodState: 'NEXT', canLink: true, period: { no: 4, start: '2026-04-01', end: '2026-04-30', part: false }, differences: [], missingLines: [], totalDifference: '0.00' });
    expect(m!.reasons).toEqual(['Bills every line of CT-0001 (2 of 2)', "The total before tax is the contract's period total", "Dated within the contract's term"]);
    expect(m!.advice).toBe('Count it as period 4 (2026-04-01 to 2026-04-30) so CT-0001 does not bill that period again.');
  });

  it('flags a period the contract already billed, and a skipped one', () => {
    const [twice] = matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ issueDate: '2026-02-10' })] });
    expect(twice).toMatchObject({ periodState: 'ALREADY_BILLED', billedBy: { id: 'd2', number: 'INV-000002' }, canLink: false });
    expect(twice!.advice).toContain('already billed period 2 on INV-000002');
    const [skipped] = matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ issueDate: '2026-03-10' })] });
    expect(skipped!.periodState).toBe('SKIPPED');
    const voided = contract({ periods: new Map([[1, { status: 'BILLED' as const, documentId: null, documentNumber: null }]]) });
    const [again] = matchInvoicesToContracts({ contracts: [voided], invoices: [invoice({ issueDate: '2026-01-20' })] });
    expect(again).toMatchObject({ periodState: 'BILLING_VOIDED', canLink: false, billedBy: null });
  });

  it('shows under-billing line by line, and earlier periods still to bill', () => {
    const [m] = matchInvoicesToContracts({
      contracts: [contract()],
      invoices: [invoice({ issueDate: '2026-06-01', subtotal: '13500.00', lines: [{ description: 'Managed support retainer', accountId: 'inc', quantity: '1', unitPrice: '8500.00' }, { description: 'Cloud hosting', accountId: 'host', quantity: '2', unitPrice: '2500.00' }] })],
    });
    expect(m).toMatchObject({ periodState: 'EARLIER_UNBILLED', canLink: false, totalDifference: '-1500.00', confidence: 'MEDIUM', score: 75 });
    expect(m!.differences).toEqual([{ description: 'Managed support retainer', billed: { quantity: '1', unitPrice: '8500.00', amount: '8500.00' }, contract: { quantity: '1', unitPrice: '10000.00', amount: '10000.00' }, difference: '-1500.00' }]);
    expect(m!.reasons).not.toContain("The prices are the contract's");
  });

  it('names lines left off, and leaves out weak matches, other customers and currencies', () => {
    const [m] = matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ subtotal: '10000.00', lines: [{ description: 'Managed support retainer', accountId: 'inc', quantity: '1', unitPrice: '10000.00' }] })] });
    expect(m).toMatchObject({ confidence: 'MEDIUM', missingLines: ['Cloud hosting'], score: 63 });
    expect(matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ lines: [{ description: 'Training', accountId: 'other', quantity: '1', unitPrice: '15000.00' }] })] })).toEqual([]);
    expect(matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ contactId: 'someone' })] })).toEqual([]);
    expect(matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ currency: 'USD' })] })).toEqual([]);
  });

  it('picks the closer of two contracts, and says when an invoice is outside the term', () => {
    const hosting = contract({ id: 'c2', ref: 'CT-0002', subtotal: '5000.00', lines: [{ description: 'Cloud hosting', accountId: 'host', quantity: '2', unitPrice: '2500.00' }], nextNo: 1, periods: new Map() });
    const [m] = matchInvoicesToContracts({ contracts: [contract(), hosting], invoices: [invoice({ subtotal: '5000.00', lines: [{ description: 'Cloud hosting', accountId: 'host', quantity: '2', unitPrice: '2500.00' }] })] });
    expect(m!.contract.ref).toBe('CT-0002');
    const [late] = matchInvoicesToContracts({ contracts: [contract()], invoices: [invoice({ issueDate: '2027-01-15' })] });
    expect(late).toMatchObject({ periodState: 'OUTSIDE_TERM', period: null, canLink: false, score: 80 });
  });
});
