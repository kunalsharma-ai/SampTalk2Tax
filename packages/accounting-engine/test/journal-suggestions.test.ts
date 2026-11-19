import { describe, expect, it } from 'vitest';
import { suggestJournals, type SuggestionAccount, type SuggestionJournal } from '../src';

const acc = (id: string, code: string, name: string, type: string, subtype: string | null = null): SuggestionAccount => ({ id, code, name, type, subtype, isActive: true, isPostable: true });
const accounts = [
  acc('bank', '1120', 'Bank', 'ASSET'),
  acc('rent', '6200', 'Rent', 'EXPENSE'),
  acc('power', '6300', 'Electricity', 'EXPENSE'),
  acc('net', '6400', 'Internet', 'EXPENSE'),
  acc('dep', '6500', 'Depreciation', 'EXPENSE'),
  acc('ap', '2100', 'Accounts payable', 'LIABILITY'),
  acc('accr', '2200', 'Accrued liabilities', 'LIABILITY', 'ACCRUED_LIABILITY'),
];
let n = 0;
const j = (date: string, debit: string, credit: string, amount: string, more: Partial<SuggestionJournal> = {}): SuggestionJournal => ({
  id: `j${++n}`,
  entryNumber: n,
  date,
  source: 'MANUAL',
  type: 'STANDARD',
  status: 'POSTED',
  isReversal: false,
  memo: null,
  lines: [
    { accountId: debit, debit: amount, credit: '0', description: null },
    { accountId: credit, debit: '0', credit: amount, description: null },
  ],
  ...more,
});

const history = [
  // Rent paid by hand on the 5th: same each month.
  j('2026-06-05', 'rent', 'bank', '50000', { memo: 'Office rent' }),
  j('2026-07-05', 'rent', 'bank', '50000', { memo: 'Office rent' }),
  j('2026-08-05', 'rent', 'bank', '50000', { memo: 'Office rent' }),
  // Electricity from bills, varying.
  j('2026-06-20', 'power', 'ap', '3000', { source: 'DOCUMENT' }),
  j('2026-07-20', 'power', 'ap', '3500', { source: 'DOCUMENT' }),
  j('2026-08-20', 'power', 'ap', '4100', { source: 'DOCUMENT' }),
  // Internet: missing in July, so no pattern.
  j('2026-06-10', 'net', 'ap', '1000', { source: 'DOCUMENT' }),
  j('2026-08-10', 'net', 'ap', '1000', { source: 'DOCUMENT' }),
  // Depreciation is posted by the asset register, not accrued.
  j('2026-06-30', 'dep', 'bank', '700', { source: 'ASSET' }),
  j('2026-07-31', 'dep', 'bank', '700', { source: 'ASSET' }),
  j('2026-08-31', 'dep', 'bank', '700', { source: 'ASSET' }),
];

describe('journal suggestions', () => {
  it('suggest a missed repeat journal and an accrual, and nothing else', () => {
    const r = suggestJournals({ month: '2026-09', today: '2026-10-03', currency: 'INR', journals: history, accounts });
    expect(r.notes).toEqual([]);
    expect(r.suggestions.map((s) => `${s.kind} ${s.title} ${s.date} ${s.total}`)).toEqual(['REPEAT Office rent 2026-09-05 50000.00', 'ACCRUAL Accrue Electricity 2026-09-30 3533.33']);
    const [rent, power] = r.suggestions;
    expect(rent!.reason).toContain('The amount was the same each month.');
    expect(rent!.basedOn.map((b) => b.date)).toEqual(['2026-06-05', '2026-07-05', '2026-08-05']);
    expect(rent!.lines).toEqual([
      { accountId: 'rent', debit: '50000.00', credit: '', description: null, departmentId: null, projectId: null },
      { accountId: 'bank', debit: '', credit: '50000.00', description: null, departmentId: null, projectId: null },
    ]);
    expect(power!.history).toEqual([
      { month: '2026-06', amount: '3000.00' },
      { month: '2026-07', amount: '3500.00' },
      { month: '2026-08', amount: '4100.00' },
    ]);
    expect(power!.lines.map((l) => `${l.accountId} ${l.debit || '-'} ${l.credit || '-'}`)).toEqual(['power 3533.33 -', 'accr - 3533.33']);
    expect(power!.memo).toBe('Accrual: Electricity for September 2026 (reverse on 1 October 2026)');
    expect(power!.type).toBe('ADJUSTING');
    expect(new Set(r.suggestions.map((s) => s.key)).size).toBe(2);
  });

  it('drop a suggestion once the month has its entry, even as a draft', () => {
    const r = suggestJournals({ month: '2026-09', today: '2026-10-03', currency: 'INR', accounts, journals: [...history, j('2026-09-05', 'rent', 'bank', '52000', { status: 'DRAFT' }), j('2026-09-21', 'power', 'ap', '3900', { source: 'DOCUMENT' })] });
    expect(r.suggestions).toEqual([]);
  });

  it('wait for the date: no repeat before its day, no accrual before the month ends', () => {
    const early = suggestJournals({ month: '2026-09', today: '2026-09-04', currency: 'INR', journals: history, accounts });
    expect(early.suggestions).toEqual([]);
    expect(early.notes).toEqual(['Accruals are suggested once September 2026 has ended.']);
    expect(suggestJournals({ month: '2026-09', today: '2026-09-06', currency: 'INR', journals: history, accounts }).suggestions.map((s) => s.kind)).toEqual(['REPEAT']);
    expect(suggestJournals({ month: '2026-11', today: '2026-10-03', currency: 'INR', journals: history, accounts }).notes).toEqual(['Suggestions are made for this month or earlier ones.']);
    expect(() => suggestJournals({ month: '2026-13', today: '2026-10-03', currency: 'INR', journals: [], accounts })).toThrow();
  });

  it('copy the latest of varying amounts, skip reversals and inactive accounts, and say when there is no accrual account', () => {
    const varied = [
      j('2026-06-15', 'rent', 'bank', '100'),
      j('2026-07-15', 'rent', 'bank', '120'),
      j('2026-08-31', 'rent', 'bank', '130'),
      j('2026-08-31', 'bank', 'rent', '130', { isReversal: true }),
    ];
    const r = suggestJournals({ month: '2026-09', today: '2026-10-03', currency: 'INR', journals: varied, accounts: accounts.filter((a) => a.id !== 'accr') });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ date: '2026-09-30', total: '130.00', title: 'Rent / Bank' });
    expect(r.suggestions[0]!.reason).toContain('The amounts varied; this copies the latest one.');
    const power = [j('2026-06-20', 'power', 'ap', '1', { source: 'DOCUMENT' }), j('2026-07-20', 'power', 'ap', '1', { source: 'DOCUMENT' }), j('2026-08-20', 'power', 'ap', '1', { source: 'DOCUMENT' })];
    expect(suggestJournals({ month: '2026-09', today: '2026-10-03', currency: 'INR', journals: power, accounts: accounts.filter((a) => a.id !== 'accr') }).notes).toEqual([expect.stringContaining('no active accrued liabilities account')]);
    const inactive = accounts.map((a) => (a.id === 'rent' ? { ...a, isActive: false } : a));
    expect(suggestJournals({ month: '2026-09', today: '2026-10-03', currency: 'INR', journals: varied, accounts: inactive }).suggestions).toEqual([]);
    // Yen has no decimals.
    const yen = suggestJournals({ month: '2026-09', today: '2026-10-03', currency: 'JPY', journals: power.map((x, i) => ({ ...x, lines: x.lines.map((l) => ({ ...l, debit: l.debit === '0' ? '0' : String(i + 1), credit: l.credit === '0' ? '0' : String(i + 1) })) })), accounts });
    expect(yen.suggestions[0]!.total).toBe('2');
  });
});
