import { describe, expect, it } from 'vitest';
import { suggestBillCoding, suggestExpenseCategory, type CategoryHistoryLine, type CodingHistoryLine } from '../src/expense-categorization';

const accounts = [
  { id: 'rent', code: '6200', name: 'Rent' },
  { id: 'util', code: '6300', name: 'Utilities' },
  { id: 'soft', code: '6400', name: 'Software and Subscriptions' },
  { id: 'mkt', code: '6500', name: 'Marketing' },
  { id: 'prof', code: '6600', name: 'Professional Fees' },
  { id: 'travel', code: '6700', name: 'Travel' },
  { id: 'meals', code: '6750', name: 'Staff Meals' },
];
const h = (merchant: string | null, description: string | null, accountId: string): CategoryHistoryLine => ({ merchant, description, accountId });

describe('expense categorisation', () => {
  it('follows how the same merchant was booked before', () => {
    const history = [h('Synthetic Cabs', 'Airport drop', 'travel'), h('Synthetic Cabs', null, 'travel'), h('synthetic cabs!', 'Client visit', 'travel'), h('Synthetic Cabs', null, 'mkt')];
    const [top, next] = suggestExpenseCategory({ merchant: 'SYNTHETIC CABS', accounts, history });
    expect(top).toEqual({ accountId: 'travel', code: '6700', name: 'Travel', confidence: 'HIGH', because: ['3 of 4 earlier lines from SYNTHETIC CABS went here', '"cabs" reads as travel'], score: 4.3 });
    expect(next).toBeUndefined(); // 0.75 points for Marketing is not enough
  });

  it('reads the kind of spending from the merchant and description', () => {
    expect(suggestExpenseCategory({ merchant: 'Uber', description: 'Office to client', accounts, history: [] })).toEqual([{ accountId: 'travel', code: '6700', name: 'Travel', confidence: 'MEDIUM', because: ['"uber" reads as travel'], score: 2 }]);
    expect(suggestExpenseCategory({ merchant: 'Cafe Mocha', description: 'Team lunch', accounts, history: [] })[0]).toMatchObject({ accountId: 'meals', because: ['"cafe" reads as meals'] });
    expect(suggestExpenseCategory({ merchant: null, description: 'Airtel broadband for October', accounts, history: [] })[0]).toMatchObject({ accountId: 'util', because: ['"airtel" reads as phone and internet'] });
    expect(suggestExpenseCategory({ merchant: 'Zoom', description: 'Annual licence', accounts, history: [] })[0]).toMatchObject({ accountId: 'soft' });
    expect(suggestExpenseCategory({ merchant: 'Unknown', description: 'Miscellaneous', accounts, history: [] })).toEqual([]);
  });

  it('adds up the signals, and only offers accounts that may be used', () => {
    const history = [h('Synthetic Grand Hotel', 'Pune trip stay', 'travel'), h('Synthetic Grand Hotel', 'Delhi trip stay', 'travel'), h('Other', 'Mumbai trip taxi', 'travel')];
    const [top] = suggestExpenseCategory({ merchant: 'Synthetic Grand Hotel', description: 'Chennai trip', accounts, history });
    expect(top).toMatchObject({ accountId: 'travel', confidence: 'HIGH', score: 6, because: ['2 of 2 earlier lines from Synthetic Grand Hotel went here', '"hotel" reads as hotel stay', '"trip" was on 3 earlier lines, 3 of them booked here'] });
    expect(suggestExpenseCategory({ merchant: 'Uber', accounts: accounts.filter((a) => a.id !== 'travel'), history: [h('Uber', null, 'travel'), h('Uber', null, 'travel')] })).toEqual([]);
  });

  it('codes bill lines with the tax, department and project the vendor usually had', () => {
    const v = (description: string, accountId: string, taxRateId: string | null, departmentId: string | null, projectId: string | null = null): CodingHistoryLine => ({ description, accountId, taxRateId, departmentId, projectId });
    const vendorHistory = [v('Monthly retainer', 'prof', 'gst18', 'fin'), v('Monthly retainer', 'prof', 'gst18', 'fin', 'p1'), v('Monthly retainer', 'prof', 'gst18', 'ops'), v('Ad campaign', 'mkt', null, null)];
    const lines = vendorHistory.map((x) => h('Synthetic Advisors', x.description, x.accountId));
    const r = suggestBillCoding({ vendor: 'Synthetic Advisors', lines: [{ lineNo: 1, description: 'Retainer for November' }, { lineNo: 2, description: null }, { lineNo: 3, description: 'Something new' }], accounts, history: lines, vendorHistory, labels: { taxRates: new Map([['gst18', 'GST 18%']]), departments: new Map([['fin', 'Finance']]) } });
    expect(r[0]).toMatchObject({ lineNo: 1, account: { accountId: 'prof', code: '6600' }, taxRateId: 'gst18', departmentId: 'fin', projectId: null });
    // Finance on 2 of 3 is most; one project on 1 of 3 is not.
    expect(r[0]!.because).toEqual(['GST 18% on 3 of 3 earlier lines from Synthetic Advisors to 6600', 'Finance on 2 of 3 earlier lines from Synthetic Advisors to 6600']);
    expect(r[1]).toMatchObject({ lineNo: 2, account: { accountId: 'prof' }, taxRateId: 'gst18' });
    expect(suggestBillCoding({ vendor: null, lines: [{ lineNo: 1, description: 'Something new' }], accounts, history: [], vendorHistory: [] })).toEqual([{ lineNo: 1, account: null, taxRateId: null, departmentId: null, projectId: null, because: [] }]);
  });
});
