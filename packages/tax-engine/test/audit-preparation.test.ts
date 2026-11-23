import { describe, expect, it } from 'vitest';
import { type AuditPrepFacts, auditPrepCsv, auditPreparation, auditPrepBlockers, auditPrepSummary } from '../src';

const clean: AuditPrepFacts = {
  yearEnded: true,
  periods: { total: 12, open: 0 },
  yearClosed: true,
  drafts: { journals: 0, documents: 0 },
  bank: { accounts: 1, unreconciled: [], unmatchedLines: 0 },
  returns: { configured: true, due: 24, notFiled: [], filedLate: 0 },
  proof: { configured: true, missing: [] },
  cashPayments: { days: 0, amount: '0.00' },
  cashReceipts: { days: 0, amount: '0.00' },
  tds: { configured: true, late: 0, interest: '0.00' },
  fixedAssets: { cost: '500000.00', depreciation: '50000.00' },
  computation: { saved: true, final: true, changedSince: false },
};
const status = (f: AuditPrepFacts) => Object.fromEntries(auditPreparation(f).map((c) => [c.key, c.status]));

describe('tax audit preparation', () => {
  it('is ready when every check passes', () => {
    const checks = auditPreparation(clean);
    expect(checks.map((c) => c.key)).toEqual(['PERIODS_LOCKED', 'YEAR_CLOSED', 'NO_DRAFTS', 'BANK_RECONCILED', 'RETURNS_FILED', 'FILING_PROOF', 'CASH_PAYMENTS', 'CASH_RECEIPTS', 'TDS_ON_TIME', 'DEPRECIATION', 'INCOME_COMPUTATION']);
    expect(auditPrepSummary(checks)).toEqual({ ready: 11, attention: 0, missing: 0, notApplicable: 0 });
    expect(auditPrepBlockers(true, checks, new Set())).toEqual([]);
  });

  it('flags what is missing and what needs explaining', () => {
    const f: AuditPrepFacts = {
      ...clean,
      periods: { total: 12, open: 3 },
      yearClosed: false,
      drafts: { journals: 1, documents: 2 },
      bank: { accounts: 2, unreconciled: [{ code: '1120', name: 'Bank', lastReconciled: '2026-01-31' }], unmatchedLines: 4 },
      returns: { configured: true, due: 10, notFiled: [{ name: 'GSTR-3B', periodLabel: 'Mar 2026', dueDate: '2026-04-20' }], filedLate: 1 },
      proof: { configured: true, missing: [{ name: 'GSTR-1', periodLabel: 'Feb 2026', needs: 'ACKNOWLEDGEMENT' }] },
      cashPayments: { days: 1, amount: '11000.00' },
      cashReceipts: { days: 2, amount: '450000.00' },
      tds: { configured: true, late: 1, interest: '45.00' },
      fixedAssets: { cost: '500000.00', depreciation: '0.00' },
      computation: { saved: true, final: false, changedSince: false },
    };
    const checks = auditPreparation(f);
    expect(status(f)).toEqual({ PERIODS_LOCKED: 'MISSING', YEAR_CLOSED: 'ATTENTION', NO_DRAFTS: 'MISSING', BANK_RECONCILED: 'MISSING', RETURNS_FILED: 'MISSING', FILING_PROOF: 'ATTENTION', CASH_PAYMENTS: 'ATTENTION', CASH_RECEIPTS: 'ATTENTION', TDS_ON_TIME: 'ATTENTION', DEPRECIATION: 'ATTENTION', INCOME_COMPUTATION: 'ATTENTION' });
    expect(checks.find((c) => c.key === 'BANK_RECONCILED')!.items).toEqual(['1120 Bank: last reconciled to 2026-01-31']);
    expect(checks.find((c) => c.key === 'NO_DRAFTS')!.detail).toBe('1 draft journal and 2 draft invoices or bills are dated in the year: post or delete them.');
    expect(checks.find((c) => c.key === 'CASH_PAYMENTS')!.detail).toContain('11000.00');
    expect(auditPrepSummary(checks)).toEqual({ ready: 0, attention: 7, missing: 4, notApplicable: 0 });
    // Missing checks block whatever the notes say; attention checks block until explained.
    const blockers = auditPrepBlockers(true, checks, new Set(['YEAR_CLOSED', 'FILING_PROOF', 'CASH_PAYMENTS', 'CASH_RECEIPTS', 'TDS_ON_TIME', 'DEPRECIATION', 'INCOME_COMPUTATION', 'NO_DRAFTS']));
    expect(blockers).toHaveLength(4);
    expect(blockers[0]).toMatch(/^Months of the year locked: 3 months of 12 still open/);
  });

  it('treats a year in progress, nothing set up and a changed computation', () => {
    const f: AuditPrepFacts = { ...clean, yearEnded: false, periods: { total: 12, open: 5 }, bank: { accounts: 0, unreconciled: [], unmatchedLines: 0 }, returns: { configured: false, due: 0, notFiled: [], filedLate: 0 }, proof: { configured: false, missing: [] }, tds: { configured: false, late: 0, interest: '0' }, fixedAssets: { cost: '0', depreciation: '0' }, computation: { saved: true, final: true, changedSince: true } };
    expect(status(f)).toMatchObject({ PERIODS_LOCKED: 'ATTENTION', BANK_RECONCILED: 'NOT_APPLICABLE', RETURNS_FILED: 'NOT_APPLICABLE', FILING_PROOF: 'NOT_APPLICABLE', TDS_ON_TIME: 'NOT_APPLICABLE', DEPRECIATION: 'NOT_APPLICABLE', INCOME_COMPUTATION: 'ATTENTION' });
    expect(auditPrepBlockers(false, auditPreparation(f), new Set(['PERIODS_LOCKED', 'INCOME_COMPUTATION']))).toEqual(['The financial year has not ended.']);
    expect(status({ ...clean, periods: { total: 0, open: 0 } }).PERIODS_LOCKED).toBe('MISSING');
    expect(status({ ...clean, computation: { saved: false, final: false, changedSince: false } }).INCOME_COMPUTATION).toBe('MISSING');
    expect(status({ ...clean, returns: { configured: true, due: 0, notFiled: [], filedLate: 0 } }).RETURNS_FILED).toBe('NOT_APPLICABLE');
  });
});

describe('tax audit preparation CSV', () => {
  it('lists each check with its note and guards formula-like text', () => {
    const checks = auditPreparation({ ...clean, cashPayments: { days: 1, amount: '11000.00' } }).map((c) => ({ ...c, note: c.key === 'CASH_PAYMENTS' ? '=Paid to a farmer, rule 6DD(e)' : null }));
    const csv = auditPrepCsv('2025-26', checks).split('\n');
    expect(csv[0]).toBe('Tax audit preparation,2025-26');
    expect(csv[1]).toBe('Check,Reference,Status,Detail,Items,Note for the auditor');
    expect(csv[8]).toBe(`"Cash payments over 10,000 a day","Clause 21(d), section 40A(3)",Needs attention,"1 day with cash paid to one person over 10,000, 11000.00 in all: disallowed unless rule 6DD covers it.",,"'=Paid to a farmer, rule 6DD(e)"`);
    expect(csv).toHaveLength(14);
  });
});
