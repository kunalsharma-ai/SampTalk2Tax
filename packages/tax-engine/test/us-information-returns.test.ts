import { describe, expect, it } from 'vitest';
import { form1099DueDates, form1099Threshold, information1099Csv, information1099Returns, nextWeekday, stateReturnPeriods, stateSalesTaxReturns, type VendorTaxProfile } from '../src';

const profile = (contactId: string, p: Partial<VendorTaxProfile> = {}): VendorTaxProfile => ({
  contactId,
  classification: 'INDIVIDUAL',
  tinType: 'SSN',
  tinLast4: '1234',
  w9ReceivedOn: '2026-01-05',
  formKind: 'NEC',
  isAttorney: false,
  ...p,
});

describe('US 1099 reporting', () => {
  it('uses $600 through 2025 and $2,000 from 2026, and rolls weekend due dates', () => {
    expect(form1099Threshold(2025)).toBe('600');
    expect(form1099Threshold(2026)).toBe('2000');
    expect(nextWeekday('2027-01-31')).toBe('2027-02-01'); // a Sunday
    expect(form1099DueDates(2026)).toEqual({ necRecipientAndIrs: '2027-02-01', miscRecipient: '2027-02-01', miscIrsPaper: '2027-03-01', miscIrsElectronic: '2027-03-31' });
  });

  it('decides each vendor and leaves nobody out', () => {
    const vendors = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ contactId: id, name: `Vendor ${id.toUpperCase()}`, countryCode: id === 'g' ? 'CA' : null }));
    const pay = (contactId: string, amount: string, byCard = false, date = '2026-03-10') => ({ contactId, amount, byCard, date });
    const r = information1099Returns({
      year: 2026,
      vendors,
      payments: [
        pay('a', '1500'),
        pay('a', '700'),
        pay('a', '9000', false, '2025-12-31'),
        pay('b', '2500'),
        pay('c', '5000'),
        pay('d', '3000'),
        pay('e', '1999.99'),
        pay('f', '4000', true),
        pay('g', '8000'),
        pay('h', '2500'),
      ],
      profiles: [
        profile('a'),
        profile('c', { classification: 'C_CORPORATION', tinType: 'EIN' }),
        profile('d', { classification: 'LLC_S', isAttorney: true, tinType: 'EIN' }),
        profile('e'),
        profile('h', { formKind: 'MISC_RENT' }),
      ],
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
    expect(by.a).toMatchObject({ status: 'REPORTABLE', form: 'NEC', box: '1', reportable: '2200.00', payments: 2 });
    expect(by.b.status).toBe('NEEDS_W9');
    expect(by.c.status).toBe('CORPORATION');
    expect(by.d).toMatchObject({ status: 'REPORTABLE', form: 'NEC' });
    expect(by.e.status).toBe('BELOW_THRESHOLD');
    expect(by.f).toMatchObject({ status: 'CARD_ONLY', paidByCard: '4000.00', reportable: '0.00' });
    expect(by.g.status).toBe('FOREIGN');
    expect(by.h).toMatchObject({ status: 'REPORTABLE', form: 'MISC', box: '1' });
    expect(r.summary).toMatchObject({ nec: 2, misc: 1, needsW9: 1, reportableTotal: '10200.00', mustEfile: false });
    const csv = information1099Csv(r);
    expect(csv.split('\n')[0]).toBe('Vendor,Status,Form,Box,Amount,Paid by card,TIN type,TIN last 4,W-9 received,Attorney');
    expect(csv).toContain('Vendor A,File a 1099,1099-NEC,1,2200.00,0.00,SSN,1234,2026-01-05,No');
  });
});

describe('State sales tax returns', () => {
  it('splits the year by filing frequency', () => {
    expect(stateReturnPeriods('QUARTERLY', 2026).map((p) => `${p.label} ${p.from} ${p.to}`)).toEqual([
      'Q1 2026 2026-01-01 2026-03-31',
      'Q2 2026 2026-04-01 2026-06-30',
      'Q3 2026 2026-07-01 2026-09-30',
      'Q4 2026 2026-10-01 2026-12-31',
    ]);
    expect(stateReturnPeriods('MONTHLY', 2028)[1].to).toBe('2028-02-29');
    expect(stateReturnPeriods('ANNUAL', 2026)).toEqual([{ label: '2026', from: '2026-01-01', to: '2026-12-31' }]);
  });

  it('totals tax per period from the permit date', () => {
    const rows = stateSalesTaxReturns({
      year: 2026,
      today: '2026-05-15',
      registrations: [{ state: 'TX', registeredFrom: '2026-02-15', filingFrequency: 'QUARTERLY' }],
      documents: [
        { kind: 'INVOICE', issueDate: '2026-02-01', state: 'TX', net: '100', tax: '8.25' },
        { kind: 'INVOICE', issueDate: '2026-03-01', state: 'TX', net: '1000', tax: '82.50' },
        { kind: 'CREDIT_NOTE', issueDate: '2026-03-20', state: 'TX', net: '200', tax: '16.50' },
        { kind: 'INVOICE', issueDate: '2026-03-02', state: 'CA', net: '500', tax: '36.25' },
        { kind: 'INVOICE', issueDate: '2026-04-10', state: 'TX', net: '400', tax: '33' },
      ],
    });
    expect(rows.map((r) => [r.label, r.from, r.netSales, r.tax, r.invoices, r.timing])).toEqual([
      ['Q1 2026', '2026-02-15', '800.00', '66.00', 1, 'PAST'],
      ['Q2 2026', '2026-04-01', '400.00', '33.00', 1, 'CURRENT'],
      ['Q3 2026', '2026-07-01', '0.00', '0.00', 0, 'FUTURE'],
      ['Q4 2026', '2026-10-01', '0.00', '0.00', 0, 'FUTURE'],
    ]);
  });
});
