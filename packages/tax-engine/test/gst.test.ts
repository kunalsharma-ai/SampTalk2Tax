import { buildDocumentJournal, computeDocument, dec, PostingAccount, TaxRateInfo, validateJournal } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import { GstCategory, gstComponents, gstHeads, gstSplitter, hsnIssue, supplyNature } from '../src';

const accounts = { cgst: 'cgst', sgst: 'sgst', igst: 'igst' };
const ledger = new Map<string, PostingAccount>(
  ['ar', 'ap', 'rev', 'cgst', 'sgst', 'igst'].map((id) => [id, { id, code: id, type: id === 'rev' ? 'REVENUE' : id === 'ar' ? 'ASSET' : 'LIABILITY', isPostable: true, isActive: true }]),
);

describe('place of supply', () => {
  it('is intra-state only when supplier and place of supply match', () => {
    expect(supplyNature('29', '29')).toBe('INTRA');
    expect(supplyNature('29', '27')).toBe('INTER');
    expect(supplyNature('29', '96')).toBe('INTER');
  });
});

describe('GST split', () => {
  it('charges IGST at the full rate on inter-state supplies', () => {
    const c = gstComponents(dec('1000.00'), dec('18'), 'TAXABLE', { nature: 'INTER', stateCode: '29', accounts }, 'INR');
    expect(c.map((x) => [x.code, x.amount.toFixed(2), x.rate.toFixed()])).toEqual([['IGST', '180.00', '18']]);
  });

  it('charges equal CGST and SGST halves, each rounded on its own', () => {
    const c = gstComponents(dec('333.33'), dec('5'), 'TAXABLE', { nature: 'INTRA', stateCode: '29', accounts }, 'INR');
    // 333.33 x 2.5% = 8.33325 -> 8.33 each; 16.66 in total (IGST at 5% would be 16.67).
    expect(c.map((x) => [x.code, x.accountId, x.amount.toFixed(2)])).toEqual([
      ['CGST', 'cgst', '8.33'],
      ['SGST', 'sgst', '8.33'],
    ]);
    expect(gstHeads(c)).toMatchObject({ cgst: dec('8.33'), sgst: dec('8.33'), igst: dec('0') });
  });

  it('uses UTGST in union territories without a legislature', () => {
    const c = gstComponents(dec('100'), dec('18'), 'TAXABLE', { nature: 'INTRA', stateCode: '04', accounts }, 'INR');
    expect(c.map((x) => x.code)).toEqual(['CGST', 'UTGST']);
    expect(c[1].accountId).toBe('sgst');
  });

  it('charges nothing on nil-rated, exempt and non-GST supplies', () => {
    for (const cat of ['NIL_RATED', 'EXEMPT', 'NON_GST'] as GstCategory[]) {
      expect(gstComponents(dec('100'), dec('0'), cat, { nature: 'INTRA', stateCode: '29', accounts }, 'INR')).toEqual([]);
    }
  });

  it('checks HSN and SAC codes', () => {
    expect(hsnIssue('8471')).toBeNull();
    expect(hsnIssue('998314')).toBeNull();
    expect(hsnIssue('84713010')).toBeNull();
    expect(hsnIssue('')).toMatch(/enter/);
    expect(hsnIssue('847')).toMatch(/4, 6 or 8/);
    expect(hsnIssue('84713')).toMatch(/4, 6 or 8/);
  });
});

describe('documents with GST', () => {
  const rates = new Map<string, TaxRateInfo>([
    ['g18', { id: 'g18', name: 'GST 18%', rate: '18', accountId: null, kind: 'GST' }],
    ['g5', { id: 'g5', name: 'GST 5%', rate: '5', accountId: null, kind: 'GST' }],
    ['nil', { id: 'nil', name: 'Nil rated', rate: '0', accountId: null, kind: 'GST' }],
    ['simple', { id: 'simple', name: 'Old 10%', rate: '10', accountId: 'tax', kind: 'SIMPLE' }],
  ]);
  const categories = new Map<string, GstCategory>([['g18', 'TAXABLE'], ['g5', 'TAXABLE'], ['nil', 'NIL_RATED']]);
  const lines = [
    { accountId: 'rev', quantity: '2', unitPrice: '1500', taxRateId: 'g18', hsnCode: '8471' },
    { accountId: 'rev', quantity: '1', unitPrice: '333.33', taxRateId: 'g5', hsnCode: '998314' },
    { accountId: 'rev', quantity: '1', unitPrice: '200', taxRateId: 'nil', hsnCode: '0401' },
  ];

  it('splits an intra-state invoice into CGST and SGST and posts a balanced journal', () => {
    const doc = computeDocument(lines, 'INR', rates, gstSplitter({ nature: 'INTRA', stateCode: '29', accounts, categories }));
    expect(doc.subtotal.toFixed(2)).toBe('3533.33');
    expect(doc.taxTotal.toFixed(2)).toBe('556.66'); // 270 + 270 + 8.33 + 8.33
    expect(doc.total.toFixed(2)).toBe('4089.99');
    expect(doc.lines[0].hsnCode).toBe('8471');
    const journal = buildDocumentJournal('INVOICE', doc, 'ar', 'INR');
    expect(validateJournal(journal, { functionalCurrency: 'INR', accounts: ledger }).totalFunctionalDebit.toFixed(2)).toBe('4089.99');
    const credit = (acc: string) => journal.filter((l) => l.accountId === acc).map((l) => l.credit);
    expect(credit('cgst')).toEqual(['278.33']);
    expect(credit('sgst')).toEqual(['278.33']);
    expect(journal.find((l) => l.accountId === 'cgst')?.description).toBe('CGST');
  });

  it('charges IGST on the same lines when the place of supply is another state', () => {
    const doc = computeDocument(lines, 'INR', rates, gstSplitter({ nature: 'INTER', stateCode: '29', accounts, categories }));
    expect(doc.taxTotal.toFixed(2)).toBe('556.67'); // 540 + 16.67
    const journal = buildDocumentJournal('BILL', doc, 'ap', 'INR');
    expect(journal.filter((l) => l.accountId === 'igst').map((l) => l.debit)).toEqual(['556.67']);
  });

  it('refuses a GST rate without GST details, a non-GST rate inside the splitter, and a non-zero nil rate', () => {
    expect(() => computeDocument([lines[0]], 'INR', rates)).toThrow(/GST details/);
    const split = gstSplitter({ nature: 'INTRA', stateCode: '29', accounts, categories: new Map() });
    expect(() => computeDocument([lines[0]], 'INR', rates, split)).toThrow(/not a GST rate/);
    const bad = new Map(rates).set('nil', { id: 'nil', name: 'Nil rated', rate: '5', accountId: null, kind: 'GST' });
    expect(() => computeDocument([lines[2]], 'INR', bad, gstSplitter({ nature: 'INTRA', stateCode: '29', accounts, categories }))).toThrow(/must be 0%/);
  });

  it('still posts simple rates to their single account', () => {
    const doc = computeDocument([{ accountId: 'rev', quantity: '1', unitPrice: '100', taxRateId: 'simple' }], 'INR', rates);
    expect(doc.lines[0].taxComponents.map((c) => [c.code, c.accountId, c.amount.toFixed(2)])).toEqual([['TAX', 'tax', '10.00']]);
  });
});
