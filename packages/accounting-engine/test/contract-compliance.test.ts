import { describe, expect, it } from 'vitest';
import { checkContractCompliance, contractFor, contractPriceKey, outsideTermIssue, type ComplianceBill, type ContractTerms } from '../src/contract-compliance';

const terms: ContractTerms = {
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  paymentTermsDays: 30,
  spendCap: '10000',
  itemsOnly: true,
  prices: [
    { key: 'hsn:7208', label: 'Steel sheet 2mm', unitPrice: '50' },
    { key: 'desc:delivery charge', label: 'Delivery charge', unitPrice: '200' },
  ],
};
let n = 0;
const bill = (issueDate: string, dueDays: number, lines: ComplianceBill['lines'], rate = '1'): ComplianceBill => {
  const subtotal = lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0).toFixed(2); // not money (test fixture)
  const due = new Date(Date.parse(`${issueDate}T00:00:00Z`) + dueDays * 86_400_000).toISOString().slice(0, 10);
  return { id: `b${++n}`, number: `BILL-${n}`, issueDate, dueDate: due, exchangeRate: rate, subtotal, lines };
};
const steel = (q: string, p: string) => ({ description: 'Steel sheet 2mm', hsnCode: '7208', quantity: q, unitPrice: p });

describe('vendor contract compliance (AP-032)', () => {
  it('keys price list entries like bill lines', () => {
    expect(contractPriceKey({ hsnCode: '72 08' })).toBe('hsn:7208');
    expect(contractPriceKey({ description: 'Delivery Charge.' })).toBe('desc:delivery charge');
    expect(contractPriceKey({})).toBeNull();
  });

  it('finds prices above the contract, items not on it, short terms and the cap', () => {
    const r = checkContractCompliance(
      terms,
      [
        bill('2026-03-20', 30, [steel('100', '60')]), // before the contract: not checked
        bill('2026-05-01', 30, [steel('100', '50'), { description: 'Delivery charge', hsnCode: null, quantity: '1', unitPrice: '200' }]),
        bill('2026-06-01', 15, [steel('100', '52'), { description: 'Packing', hsnCode: null, quantity: '1', unitPrice: '100' }]),
        bill('2026-07-01', 30, [steel('50', '50')]),
      ],
      'INR',
    );
    expect(r).toMatchObject({ spend: '13000.00', capUsed: '130.0', billsChecked: 3, billsWithIssues: 2, overcharge: '200.00' });
    expect(r.issues.map((i) => [i.billNumber, i.code, i.severity, i.amount])).toEqual([
      ['BILL-3', 'PRICE_ABOVE', 'HIGH', '200.00'],
      ['BILL-3', 'NOT_IN_CONTRACT', 'LOW', null],
      ['BILL-3', 'SHORT_TERMS', 'MEDIUM', null],
      ['BILL-3', 'OVER_CAP', 'HIGH', '500.00'],
      ['BILL-4', 'OVER_CAP', 'HIGH', '2500.00'],
    ]);
    expect(r.issues[0]!.detail).toBe('Steel sheet 2mm: billed 52.00 a unit, the contract price is 50.00 (100 units)');
    expect(r.issues[2]!.detail).toBe('Due 15 days after the bill date; the contract gives 30 days');
    expect(r.issues[3]!.detail).toBe('Spend under the contract reaches 10500.00, above the cap of 10000.00');
  });

  it('converts foreign bills and stays quiet within the terms', () => {
    const r = checkContractCompliance({ ...terms, itemsOnly: false, spendCap: null, paymentTermsDays: null }, [bill('2026-05-01', 10, [steel('10', '0.6'), { description: 'Anything', hsnCode: null, quantity: '1', unitPrice: '1' }], '83')], 'INR');
    expect(r.issues.map((i) => i.code)).toEqual([]);
    expect(r).toMatchObject({ spend: '581.00', capUsed: null, overcharge: '0.00' });
  });

  it('finds the contract covering a date and describes a bill outside the term', () => {
    const cs = [{ startDate: '2025-04-01', endDate: '2026-03-31', reference: 'VC-001' }, { startDate: '2026-06-01', endDate: '2026-12-31', reference: 'VC-002' }];
    expect(contractFor(cs, '2026-03-31')?.reference).toBe('VC-001');
    expect(contractFor(cs, '2026-06-01')?.reference).toBe('VC-002');
    expect(contractFor(cs, '2026-05-01')).toBeNull();
    expect(outsideTermIssue({ id: 'x', number: 'B-9', issueDate: '2026-05-01' }, cs[0]!)).toMatchObject({ code: 'OUTSIDE_TERM', severity: 'MEDIUM', detail: 'Billed on 2026-05-01, after contract VC-001 ended on 2026-03-31' });
  });
});
