import { applyReverseCharge, applyWithholding, buildDocumentJournal, computeDocument, dec, PostingAccount, TaxRateInfo, validateJournal } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import { checkPan, computeWithholding, depositDueDate, gstSplitter, panFromGstin, TDS_TEMPLATES, taxQuarterOf, taxYearOf, tanIssue, thresholdWindow, WithholdingRule } from '../src';

const t = (code: string): WithholdingRule => ({ ...TDS_TEMPLATES.find((x) => x.code === code)!, kind: 'TDS' });
const contractor = t('393(1)-6(i)');
const professional = t('393(1)-6(iii)(b)');
const rentBuilding = t('393(1)-2(ii)(b)');
const goods = t('393(1)-8(ii)');
const none = { aggregateBefore: '0', taxedBefore: '0' };
const COMPANY = 'ZZZCE0001Z';
const PERSON = 'ZZZPE0001Z';

describe('PAN and TAN', () => {
  it('checks the shape and reads the holder type', () => {
    expect(checkPan('zzzpe0001z')).toMatchObject({ valid: true, pan: 'ZZZPE0001Z', holderType: 'Individual', isIndividualOrHuf: true });
    expect(checkPan(COMPANY)).toMatchObject({ valid: true, holderType: 'Company', isIndividualOrHuf: false });
    expect(checkPan('ZZZXE0001Z').issues[0]).toMatch(/holder type/);
    expect(checkPan('ZZZ1E0001Z').valid).toBe(false);
    expect(panFromGstin('27ZZZCE0001Z1Z5')).toBe(COMPANY);
    expect(tanIssue('PNEA12345B')).toBeNull();
    expect(tanIssue('PNE123456B')).toMatch(/four letters/);
  });
});

describe('periods and due dates', () => {
  it('uses April to March tax years and quarters', () => {
    expect(taxYearOf('2026-11-01')).toEqual({ from: '2026-04-01', to: '2027-03-31', label: '2026-27' });
    expect(taxYearOf('2027-03-31').label).toBe('2026-27');
    expect(taxQuarterOf('2026-11-15')).toMatchObject({ quarter: 3, from: '2026-10-01', to: '2026-12-31', label: 'Q3 2026-27' });
    expect(taxQuarterOf('2027-02-01')).toMatchObject({ quarter: 4, from: '2027-01-01', to: '2027-03-31' });
    expect(thresholdWindow('MONTH', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('is due on the 7th of the next month, and 30 April for March', () => {
    expect(depositDueDate('2026-10-31')).toBe('2026-11-07');
    expect(depositDueDate('2026-12-05')).toBe('2027-01-07');
    expect(depositDueDate('2027-03-31')).toBe('2027-04-30');
  });
});

describe('TDS thresholds', () => {
  it('deducts on a contractor bill above the single-payment limit, at 1% for an individual', () => {
    expect(computeWithholding(contractor, '30000', none, COMPANY)).toMatchObject({ base: '0.00', amount: '0.00' });
    expect(computeWithholding(contractor, '30000.01', none, COMPANY)).toMatchObject({ base: '30000.01', rate: '2', amount: '600.00' });
    expect(computeWithholding(contractor, '40000', none, PERSON)).toMatchObject({ rate: '1', amount: '400.00' });
  });

  it('catches up earlier small bills when the year crosses the aggregate limit', () => {
    // Three bills of 25,000: none alone is above 30,000; the fifth takes the year to 1,25,000.
    expect(computeWithholding(contractor, '25000', { aggregateBefore: '75000', taxedBefore: '0' }, COMPANY)).toMatchObject({ base: '0.00' });
    const r = computeWithholding(contractor, '25000', { aggregateBefore: '100000', taxedBefore: '0' }, COMPANY);
    expect(r).toMatchObject({ base: '125000.00', amount: '2500.00' });
    expect(r.reason).toMatch(/earlier amounts of 100000.00 are included/);
    // After that, only the new bill is taxed.
    expect(computeWithholding(contractor, '10000', { aggregateBefore: '125000', taxedBefore: '125000' }, COMPANY)).toMatchObject({ base: '10000.00', amount: '200.00' });
  });

  it('does not tax twice what a single large bill already covered', () => {
    const r = computeWithholding(contractor, '20000', { aggregateBefore: '90000', taxedBefore: '40000' }, COMPANY);
    expect(r).toMatchObject({ base: '70000.00', amount: '1400.00' });
  });

  it('applies the higher no-PAN rate', () => {
    expect(computeWithholding(professional, '60000', none, null)).toMatchObject({ rate: '20', amount: '12000.00' });
    expect(computeWithholding(professional, '60000', none, COMPANY)).toMatchObject({ rate: '10', amount: '6000.00' });
  });

  it('measures rent per month', () => {
    expect(computeWithholding(rentBuilding, '50000', none, COMPANY).amount).toBe('0.00');
    expect(computeWithholding(rentBuilding, '50001', none, COMPANY).amount).toBe('5000.10');
  });

  it('taxes only the excess for purchase of goods', () => {
    expect(computeWithholding(goods, '4000000', { aggregateBefore: '3000000', taxedBefore: '0' }, COMPANY)).toMatchObject({ base: '2000000.00', amount: '2000.00' });
    expect(computeWithholding(goods, '100000', { aggregateBefore: '7000000', taxedBefore: '2000000' }, COMPANY)).toMatchObject({ base: '100000.00', amount: '100.00' });
  });

  it('rounds to paise half-even', () => {
    expect(computeWithholding({ ...professional, aggregateThreshold: null }, '0.25', none, COMPANY).amount).toBe('0.02');
    expect(computeWithholding({ ...professional, aggregateThreshold: null }, '0.35', none, COMPANY).amount).toBe('0.04');
  });
});

describe('documents with TDS, TCS and reverse charge', () => {
  const accounts = new Map<string, PostingAccount>(
    ['ar', 'ap', 'rev', 'exp', 'icgst', 'isgst', 'iigst', 'ocgst', 'osgst', 'oigst', 'tds', 'tcs'].map((id) => [
      id,
      { id, code: id, type: ['ar', 'icgst', 'isgst', 'iigst'].includes(id) ? 'ASSET' : id === 'rev' ? 'REVENUE' : id === 'exp' ? 'EXPENSE' : 'LIABILITY', isPostable: true, isActive: true },
    ]),
  );
  const rates = new Map<string, TaxRateInfo>([['g18', { id: 'g18', name: 'GST 18%', rate: '18', accountId: null, kind: 'GST' }]]);
  const categories = new Map([['g18', 'TAXABLE' as const]]);
  const input = { cgst: 'icgst', sgst: 'isgst', igst: 'iigst' };
  const rcmMap = new Map([['icgst', 'ocgst'], ['isgst', 'osgst'], ['iigst', 'oigst']]);
  const line = [{ accountId: 'exp', quantity: '1', unitPrice: '100000', taxRateId: 'g18', hsnCode: '998211' }];

  it('posts a bill with TDS: the vendor is owed the total less TDS', () => {
    const d = computeDocument(line, 'INR', rates, gstSplitter({ nature: 'INTRA', stateCode: '27', accounts: input, categories }));
    const w = applyWithholding(d, { label: 'TDS 393(1)-6(iii)(b)', accountId: 'tds', amount: dec('10000'), effect: 'DEDUCT' }, 'INR');
    expect(w.total.toFixed(2)).toBe('108000.00');
    const j = buildDocumentJournal('BILL', w, 'ap', 'INR');
    expect(j).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'ap', credit: '108000' }),
      expect.objectContaining({ accountId: 'tds', credit: '10000' }),
      expect.objectContaining({ accountId: 'icgst', debit: '9000' }),
    ]));
    expect(validateJournal(j, { functionalCurrency: 'INR', accounts }).totalFunctionalDebit.toFixed(2)).toBe('118000.00');
  });

  it('posts an invoice with TCS: the customer pays the total plus TCS', () => {
    const d = computeDocument([{ ...line[0], accountId: 'rev' }], 'INR', rates, gstSplitter({ nature: 'INTER', stateCode: '29', accounts: { cgst: 'ocgst', sgst: 'osgst', igst: 'oigst' }, categories }));
    const w = applyWithholding(d, { label: 'TCS', accountId: 'tcs', amount: dec('1180'), effect: 'COLLECT' }, 'INR');
    const j = buildDocumentJournal('INVOICE', w, 'ar', 'INR');
    expect(j[0]).toMatchObject({ accountId: 'ar', debit: '119180' });
    expect(j).toContainEqual(expect.objectContaining({ accountId: 'tcs', credit: '1180' }));
    validateJournal(j, { functionalCurrency: 'INR', accounts });
  });

  it('posts a reverse-charge bill: credit and liability for the GST, the vendor is owed the net', () => {
    const d = applyReverseCharge(computeDocument(line, 'INR', rates, gstSplitter({ nature: 'INTRA', stateCode: '27', accounts: input, categories })), rcmMap);
    expect([d.subtotal.toFixed(2), d.taxTotal.toFixed(2), d.total.toFixed(2), d.reverseCharge!.tax.toFixed(2)]).toEqual(['100000.00', '0.00', '100000.00', '18000.00']);
    const j = buildDocumentJournal('BILL', d, 'ap', 'INR');
    expect(j).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'ap', credit: '100000' }),
      expect.objectContaining({ accountId: 'icgst', debit: '9000' }),
      expect.objectContaining({ accountId: 'isgst', debit: '9000' }),
      expect.objectContaining({ accountId: 'ocgst', credit: '9000' }),
      expect.objectContaining({ accountId: 'osgst', credit: '9000' }),
    ]));
    validateJournal(j, { functionalCurrency: 'INR', accounts });
    // A vendor credit against it reverses both sides.
    const vc = buildDocumentJournal('VENDOR_CREDIT', d, 'ap', 'INR');
    expect(vc).toContainEqual(expect.objectContaining({ accountId: 'ocgst', debit: '9000' }));
    expect(vc).toContainEqual(expect.objectContaining({ accountId: 'icgst', credit: '9000' }));
  });

  it('combines reverse charge with TDS on the net amount', () => {
    const d = applyReverseCharge(computeDocument(line, 'INR', rates, gstSplitter({ nature: 'INTER', stateCode: '27', accounts: input, categories })), rcmMap);
    const w = applyWithholding(d, { label: 'TDS', accountId: 'tds', amount: dec('10000'), effect: 'DEDUCT' }, 'INR');
    const j = buildDocumentJournal('BILL', w, 'ap', 'INR');
    expect(j[0]).toMatchObject({ credit: '90000' });
    expect(validateJournal(j, { functionalCurrency: 'INR', accounts }).totalFunctionalDebit.toFixed(2)).toBe('118000.00');
    expect(() => applyWithholding(w, { label: 'x', accountId: 'tds', amount: dec('1'), effect: 'DEDUCT' }, 'INR')).toThrow(/at most one/);
    expect(() => applyWithholding(d, { label: 'x', accountId: 'tds', amount: dec('0.001'), effect: 'DEDUCT' }, 'INR')).toThrow(/decimal places/);
  });
});
