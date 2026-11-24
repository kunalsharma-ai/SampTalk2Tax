import { describe, expect, it } from 'vitest';
import { nexusExposure, salesTaxByState, US_STATES, usState, type UsSalesTaxDocument } from '../src/us/sales-tax';

describe('US states (TAX-028)', () => {
  it('lists the 50 states and DC, five without a statewide sales tax', () => {
    expect(US_STATES).toHaveLength(51);
    expect(US_STATES.filter((x) => !x.salesTax).map((x) => x.code)).toEqual(['AK', 'DE', 'MT', 'NH', 'OR']);
    expect(usState('ca')).toMatchObject({ name: 'California', salesThreshold: '500000' });
    expect(usState('XX')).toBeNull();
  });
});

describe('economic nexus', () => {
  it('flags states over, near and below the threshold, and registered ones', () => {
    const rows = nexusExposure({
      currentYear: [
        { state: 'WA', sales: '120000', transactions: 10 },
        { state: 'CA', sales: '420000', transactions: 50 },
        { state: 'FL', sales: '20000', transactions: 5 },
        { state: 'OR', sales: '90000', transactions: 300 },
        { state: 'GA', sales: '5000', transactions: 210 },
      ],
      previousYear: [{ state: 'CO', sales: '150000', transactions: 20 }],
      registered: ['CO'],
    });
    const st = Object.fromEntries(rows.map((r) => [r.state, r.status]));
    expect(st).toEqual({ WA: 'MUST_REGISTER', GA: 'MUST_REGISTER', CA: 'APPROACHING', CO: 'REGISTERED', FL: 'BELOW', OR: 'NO_SALES_TAX' });
    expect(rows.find((r) => r.state === 'CO')!.measuredOn).toBe('PREVIOUS');
    expect(rows.find((r) => r.state === 'CA')!.shareOfThreshold).toBe('84');
  });

  it('needs both tests where a state says AND (New York)', () => {
    expect(nexusExposure({ currentYear: [{ state: 'NY', sales: '600000', transactions: 50 }], previousYear: [], registered: [] })[0]!.status).toBe('APPROACHING');
    expect(nexusExposure({ currentYear: [{ state: 'NY', sales: '600000', transactions: 100 }], previousYear: [], registered: [] })[0]!.status).toBe('MUST_REGISTER');
  });
});

describe('sales tax by state', () => {
  let n = 0;
  const doc = (o: Partial<UsSalesTaxDocument>): UsSalesTaxDocument => ({
    id: `d${++n}`,
    kind: 'INVOICE',
    number: `INV-${n}`,
    issueDate: '2026-10-01',
    contactId: 'c',
    contactName: 'Customer',
    state: 'TX',
    net: '100',
    tax: '8.25',
    ...o,
  });
  it('totals by state with credit notes and flags what looks wrong', () => {
    const r = salesTaxByState({
      registrations: [
        { state: 'TX', rate: '8.25' },
        { state: 'WA', rate: null },
      ],
      documents: [
        doc({}),
        doc({ kind: 'CREDIT_NOTE', net: '50', tax: '4.125' }),
        doc({ net: '200', tax: '0' }),
        doc({ state: 'TX', net: '100', tax: '6.25' }),
        doc({ state: 'CA', net: '100', tax: '7.25' }),
        doc({ state: null }),
        doc({ state: 'WA', net: '100', tax: '0', exempt: true }),
      ],
    });
    expect(r.states.find((x) => x.state === 'TX')).toMatchObject({ registered: true, gross: '350.00', taxable: '150.00', nonTaxable: '200.00', tax: '10.38', documents: 4 });
    expect(r.states.at(-1)!.state).toBe('UNKNOWN');
    expect(r.issues.map((i) => i.kind).sort()).toEqual(['NO_TAX_IN_REGISTERED_STATE', 'RATE_DIFFERS', 'STATE_MISSING', 'TAX_IN_UNREGISTERED_STATE']);
  });
});
