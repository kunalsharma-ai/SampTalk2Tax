import { D } from '@talk2tax/accounting-engine';

/**
 * Tax audit preparation (TAX-051): what is left to do before a financial year's books go to the tax
 * auditor, worked out from facts gathered from the books, the compliance calendar, the tax audit
 * working papers and the income tax computation. Each check is READY, needs ATTENTION (something
 * the auditor will ask about: explain it in a note or fix it), is MISSING (fix it before the audit),
 * or does not apply. Nothing here guesses: every status follows from a count or an amount.
 */
export type PrepStatus = 'READY' | 'ATTENTION' | 'MISSING' | 'NOT_APPLICABLE';

export const AUDIT_PREP_CHECK_KEYS = [
  'PERIODS_LOCKED',
  'YEAR_CLOSED',
  'NO_DRAFTS',
  'BANK_RECONCILED',
  'RETURNS_FILED',
  'FILING_PROOF',
  'CASH_PAYMENTS',
  'CASH_RECEIPTS',
  'TDS_ON_TIME',
  'DEPRECIATION',
  'INCOME_COMPUTATION',
] as const;
export type AuditPrepCheckKey = (typeof AUDIT_PREP_CHECK_KEYS)[number];

export interface AuditPrepFacts {
  yearEnded: boolean;
  periods: { total: number; open: number };
  yearClosed: boolean;
  drafts: { journals: number; documents: number };
  bank: { accounts: number; unreconciled: { code: string; name: string; lastReconciled: string | null }[]; unmatchedLines: number };
  returns: { configured: boolean; due: number; notFiled: { name: string; periodLabel: string; dueDate: string }[]; filedLate: number };
  proof: { configured: boolean; missing: { name: string; periodLabel: string; needs: string }[] };
  cashPayments: { days: number; amount: string };
  cashReceipts: { days: number; amount: string };
  tds: { configured: boolean; late: number; interest: string };
  fixedAssets: { cost: string; depreciation: string };
  computation: { saved: boolean; final: boolean; changedSince: boolean };
}

export interface AuditPrepCheck {
  key: AuditPrepCheckKey;
  title: string;
  /** Form 3CD clause or section the check feeds, when there is one. */
  reference: string | null;
  status: PrepStatus;
  detail: string;
  items: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`; // not money
const LIST = 20;

/** The checks for one year, in the order a preparer would work through them. */
export function auditPreparation(f: AuditPrepFacts): AuditPrepCheck[] {
  const checks: AuditPrepCheck[] = [];
  const add = (key: AuditPrepCheckKey, title: string, reference: string | null, status: PrepStatus, detail: string, items: string[] = []) =>
    checks.push({ key, title, reference, status, detail, items: items.slice(0, LIST) });

  if (f.periods.total === 0) add('PERIODS_LOCKED', 'Months of the year locked', null, 'MISSING', 'No accounting periods are set up for this year.');
  else if (f.periods.open > 0) add('PERIODS_LOCKED', 'Months of the year locked', null, f.yearEnded ? 'MISSING' : 'ATTENTION', `${plural(f.periods.open, 'month')} of ${f.periods.total} still open: lock them so the audited figures cannot change.`);
  else add('PERIODS_LOCKED', 'Months of the year locked', null, 'READY', `All ${f.periods.total} months are locked or closed.`);

  add('YEAR_CLOSED', 'Year closed to retained earnings', null, f.yearClosed ? 'READY' : 'ATTENTION', f.yearClosed ? "The year's profit is closed to retained earnings." : "The year's profit has not been closed to retained earnings yet (Year-end close).");

  const drafts = f.drafts.journals + f.drafts.documents; // not money
  add('NO_DRAFTS', 'No drafts dated in the year', null, drafts ? 'MISSING' : 'READY', drafts ? `${plural(f.drafts.journals, 'draft journal')} and ${plural(f.drafts.documents, 'draft invoice or bill', 'draft invoices or bills')} are dated in the year: post or delete them.` : 'Nothing dated in the year is left in draft.');

  if (!f.bank.accounts) add('BANK_RECONCILED', 'Bank accounts reconciled to the year end', null, 'NOT_APPLICABLE', 'No bank statements are imported for the year.');
  else if (f.bank.unreconciled.length) add('BANK_RECONCILED', 'Bank accounts reconciled to the year end', null, 'MISSING', `${plural(f.bank.unreconciled.length, 'bank account')} not reconciled to the year end.`, f.bank.unreconciled.map((b) => `${b.code} ${b.name}: ${b.lastReconciled ? `last reconciled to ${b.lastReconciled}` : 'never reconciled'}`));
  else if (f.bank.unmatchedLines) add('BANK_RECONCILED', 'Bank accounts reconciled to the year end', null, 'ATTENTION', `Reconciled, but ${plural(f.bank.unmatchedLines, 'statement line')} dated in the year ${f.bank.unmatchedLines === 1 ? 'is' : 'are'} still unmatched.`);
  else add('BANK_RECONCILED', 'Bank accounts reconciled to the year end', null, 'READY', `${plural(f.bank.accounts, 'bank account')} reconciled to the year end.`);

  if (!f.returns.configured) add('RETURNS_FILED', 'Returns and tax payments for the year', 'Clauses 34, 44', 'NOT_APPLICABLE', 'No GST, TDS, payroll or advance tax is set up.');
  else if (f.returns.notFiled.length) add('RETURNS_FILED', 'Returns and tax payments for the year', 'Clauses 34, 44', 'MISSING', `${plural(f.returns.notFiled.length, 'return or payment', 'returns or payments')} for the year ${f.returns.notFiled.length === 1 ? 'is' : 'are'} past the due date and not marked done.`, f.returns.notFiled.map((r) => `${r.name} (${r.periodLabel}), due ${r.dueDate}`));
  else if (f.returns.filedLate) add('RETURNS_FILED', 'Returns and tax payments for the year', 'Clauses 34, 44', 'ATTENTION', `All ${plural(f.returns.due, 'return or payment', 'returns and payments')} done, ${f.returns.filedLate} after the due date: late fees and interest are reported.`);
  else add('RETURNS_FILED', 'Returns and tax payments for the year', 'Clauses 34, 44', f.returns.due ? 'READY' : 'NOT_APPLICABLE', f.returns.due ? `All ${plural(f.returns.due, 'return or payment', 'returns and payments')} due so far ${f.returns.due === 1 ? 'is' : 'are'} done on time.` : 'Nothing for the year has fallen due yet.');

  if (!f.proof.configured) add('FILING_PROOF', 'Acknowledgements and challans on file', null, 'NOT_APPLICABLE', 'No returns or payments to keep proof of.');
  else if (f.proof.missing.length) add('FILING_PROOF', 'Acknowledgements and challans on file', null, 'ATTENTION', `${plural(f.proof.missing.length, 'return or payment', 'returns and payments')} done without the acknowledgement or challan on file (Compliance documents).`, f.proof.missing.map((m) => `${m.name} (${m.periodLabel}): ${m.needs.toLowerCase()}`));
  else add('FILING_PROOF', 'Acknowledgements and challans on file', null, 'READY', 'Every return and payment done has its acknowledgement or challan on file.');

  add('CASH_PAYMENTS', 'Cash payments over 10,000 a day', 'Clause 21(d), section 40A(3)', f.cashPayments.days ? 'ATTENTION' : 'READY', f.cashPayments.days ? `${plural(f.cashPayments.days, 'day')} with cash paid to one person over 10,000, ${f.cashPayments.amount} in all: disallowed unless rule 6DD covers it.` : 'No cash payment over 10,000 a day to one person.');
  add('CASH_RECEIPTS', 'Cash received of 2 lakh or more', 'Clause 31, section 269ST', f.cashReceipts.days ? 'ATTENTION' : 'READY', f.cashReceipts.days ? `${plural(f.cashReceipts.days, 'day')} with 2 lakh or more in cash from one person, ${f.cashReceipts.amount} in all: reported, and penalty under 271DA may apply.` : 'No cash receipt of 2 lakh or more from one person in a day.');

  if (!f.tds.configured) add('TDS_ON_TIME', 'TDS deposited on time', 'Clause 34', 'NOT_APPLICABLE', 'TDS is not set up.');
  else add('TDS_ON_TIME', 'TDS deposited on time', 'Clause 34', f.tds.late ? 'ATTENTION' : 'READY', f.tds.late ? `${plural(f.tds.late, 'deduction')} deposited late or not yet, with interest of ${f.tds.interest} under 201(1A).` : 'All TDS deducted in the year was deposited by the due date.');

  const cost = new D(f.fixedAssets.cost);
  if (cost.lte(0)) add('DEPRECIATION', 'Depreciation for the year', 'Clause 18', 'NOT_APPLICABLE', 'No fixed assets in the books.');
  else if (new D(f.fixedAssets.depreciation).lte(0)) add('DEPRECIATION', 'Depreciation for the year', 'Clause 18', 'ATTENTION', `Fixed assets of ${cost.toFixed(2)} at cost, but no depreciation is posted for the year.`);
  else add('DEPRECIATION', 'Depreciation for the year', 'Clause 18', 'READY', `Depreciation of ${new D(f.fixedAssets.depreciation).toFixed(2)} posted for the year.`);

  if (!f.computation.saved) add('INCOME_COMPUTATION', 'Income tax computation', null, 'MISSING', 'The income tax computation has not been prepared.');
  else if (!f.computation.final) add('INCOME_COMPUTATION', 'Income tax computation', null, 'ATTENTION', 'The income tax computation is saved but not finalised.');
  else if (f.computation.changedSince) add('INCOME_COMPUTATION', 'Income tax computation', null, 'ATTENTION', 'The computation is final, but postings to the year changed the profit since.');
  else add('INCOME_COMPUTATION', 'Income tax computation', null, 'READY', 'The income tax computation is final and matches the books.');
  return checks;
}

/** Counts by status. */
export function auditPrepSummary(checks: readonly AuditPrepCheck[]) {
  const n = (s: PrepStatus) => checks.filter((c) => c.status === s).length; // not money
  return { ready: n('READY'), attention: n('ATTENTION'), missing: n('MISSING'), notApplicable: n('NOT_APPLICABLE') };
}

/**
 * What stops the year being marked ready for the auditor: the year must have ended, nothing may be
 * MISSING, and every check needing ATTENTION must carry an explanation for the auditor.
 */
export function auditPrepBlockers(yearEnded: boolean, checks: readonly AuditPrepCheck[], explained: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!yearEnded) out.push('The financial year has not ended.');
  for (const c of checks) {
    if (c.status === 'MISSING') out.push(`${c.title}: ${c.detail}`);
    else if (c.status === 'ATTENTION' && !explained.has(c.key)) out.push(`${c.title}: add a note for the auditor or fix it.`);
  }
  return out;
}

const STATUS_LABEL: Record<PrepStatus, string> = { READY: 'Ready', ATTENTION: 'Needs attention', MISSING: 'Missing', NOT_APPLICABLE: 'Does not apply' };

/** The checklist as CSV for the auditor: one row per check with its note, formula-like text guarded. */
export function auditPrepCsv(year: string, checks: readonly (AuditPrepCheck & { note: string | null })[]): string {
  const risky = (v: string) => /^[=+@]/.test(v) || /^-(?!\d)/.test(v);
  const q = (v: string) => {
    const t = risky(v) ? `'${v}` : v;
    return risky(v) || /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const out = [['Tax audit preparation', year].map(q).join(','), ['Check', 'Reference', 'Status', 'Detail', 'Items', 'Note for the auditor'].map(q).join(',')];
  for (const c of checks) out.push([c.title, c.reference ?? '', STATUS_LABEL[c.status], c.detail, c.items.join('; '), c.note ?? ''].map(q).join(','));
  return `${out.join('\n')}\n`;
}
