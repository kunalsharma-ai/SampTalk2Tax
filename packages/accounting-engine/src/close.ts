/**
 * Month-end close: the checklist worked out from the books, what the AI model is shown when
 * it reviews a month, and the checks every adjusting entry it proposes must pass before a
 * person can post it.
 *
 * The checklist is plain rules over counts and balances. The model never decides whether a
 * month can close; it only proposes adjusting entries (accruals, prepayments, reclasses) and
 * points out what looks unusual. A person posts or rejects each entry, and an owner or admin
 * closes the month, which locks it.
 * No framework or database code. Money is decimal strings.
 */
import type { Confidence } from './bank-ai';
import { CONFIDENCE_LEVELS } from './bank-ai';
import { D, Dec } from './money';
import { formatAmountText, formatDateText } from './workflows';

export const CLOSE_CHECK_KEYS = [
  'DRAFT_JOURNALS',
  'UNMATCHED_BANK_LINES',
  'TRIAL_BALANCE',
  'DRAFT_DOCUMENTS',
  'BANK_NOT_RECONCILED',
  'PENDING_APPROVALS',
  'EXPENSE_CLAIMS_WAITING',
  'PAYROLL_NOT_POSTED',
  'DEPRECIATION_MISSING',
  'DEFERRALS_NOT_POSTED',
  'NEGATIVE_CASH',
  'AI_WAITING',
  'EARLIER_PERIODS_OPEN',
] as const;
export type CloseCheckKey = (typeof CLOSE_CHECK_KEYS)[number];
export type CloseSeverity = 'BLOCKING' | 'WARNING';

/** What the books say about one month, gathered by the API. */
export interface CloseFacts {
  currency: string;
  period: { name: string; startDate: string; endDate: string };
  /** Draft journals dated in the month. */
  draftJournals: number;
  /** Draft invoices, bills and credit notes dated in the month. */
  draftDocuments: number;
  /** Bank and cash accounts with statement lines up to the month end that are neither matched nor excluded. */
  unmatchedBankLines: { code: string; name: string; count: number }[];
  /** Bank accounts with statement lines but no completed reconciliation on or after the month end. */
  unreconciledBankAccounts: { code: string; name: string; lastReconciled: string | null }[];
  pendingApprovals: number;
  submittedExpenseClaims: number;
  /** Null when the organisation has no active employees. */
  payroll: { posted: boolean; drafts: number } | null;
  /** Fixed assets carried at the month end but no depreciation posted in the month. */
  depreciation: { fixedAssets: string; postedThisMonth: string };
  /** Prepaid and deferred revenue releases due through the month end that are not posted. */
  deferrals: { schedules: number; amount: string };
  /** Cash accounts below zero at the month end (cash cannot be negative). */
  negativeCash: { code: string; name: string; balance: string }[];
  /** AI items waiting for a person: bank suggestions for lines up to the month end, and this close's proposed entries. */
  aiWaiting: { bankSuggestions: number; adjustments: number };
  /** Totals of all posted journal lines up to the month end. */
  trialBalance: { debit: string; credit: string };
  /** Earlier periods of this or an earlier fiscal year that are still open. */
  earlierOpenPeriods: string[];
}

export interface CloseCheck {
  key: CloseCheckKey;
  severity: CloseSeverity;
  ok: boolean;
  label: string;
  detail: string;
  count: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The month-end checklist, blocking checks first. */
export function evaluateClose(f: CloseFacts): CloseCheck[] {
  const money = (v: string | Dec) => {
    const x = new D(v);
    return `${x.isNeg() ? '-' : ''}${formatAmountText(x.abs().toFixed(2), f.currency)}`;
  };
  const lines = f.unmatchedBankLines.reduce((s, a) => s + a.count, 0);
  const tbDiff = new D(f.trialBalance.debit).minus(f.trialBalance.credit);
  const assets = new D(f.depreciation.fixedAssets);
  const depreciationMissing = assets.gt(0) && new D(f.depreciation.postedThisMonth).lte(0);
  const ai = f.aiWaiting.bankSuggestions + f.aiWaiting.adjustments;
  const checks: CloseCheck[] = [
    {
      key: 'DRAFT_JOURNALS',
      severity: 'BLOCKING',
      ok: f.draftJournals === 0,
      count: f.draftJournals,
      label: 'No draft journals in the month',
      detail: f.draftJournals ? `${plural(f.draftJournals, 'draft journal')} dated in ${f.period.name}: post or delete them` : 'Every journal dated in the month is posted',
    },
    {
      key: 'UNMATCHED_BANK_LINES',
      severity: 'BLOCKING',
      ok: lines === 0,
      count: lines,
      label: 'Every bank line up to the month end is matched',
      detail: lines ? `${plural(lines, 'bank line')} not matched or excluded: ${f.unmatchedBankLines.map((a) => `${a.code} ${a.name} (${a.count})`).join(', ')}` : 'Nothing left to match on any bank or cash account',
    },
    {
      key: 'TRIAL_BALANCE',
      severity: 'BLOCKING',
      ok: tbDiff.isZero(),
      count: tbDiff.isZero() ? 0 : 1,
      label: 'The trial balance balances',
      detail: tbDiff.isZero() ? `Debits and credits are both ${money(f.trialBalance.debit)}` : `Debits ${money(f.trialBalance.debit)} and credits ${money(f.trialBalance.credit)} differ by ${money(tbDiff.abs())}`,
    },
    {
      key: 'DRAFT_DOCUMENTS',
      severity: 'WARNING',
      ok: f.draftDocuments === 0,
      count: f.draftDocuments,
      label: 'No draft invoices or bills in the month',
      detail: f.draftDocuments ? `${plural(f.draftDocuments, 'draft invoice or bill', 'draft invoices or bills')} dated in the month are not in the books` : 'Every invoice and bill dated in the month is posted',
    },
    {
      key: 'BANK_NOT_RECONCILED',
      severity: 'WARNING',
      ok: f.unreconciledBankAccounts.length === 0,
      count: f.unreconciledBankAccounts.length,
      label: 'Bank accounts reconciled to the month end',
      detail: f.unreconciledBankAccounts.length
        ? `Not reconciled to ${formatDateText(f.period.endDate)}: ${f.unreconciledBankAccounts.map((a) => `${a.code} ${a.name} (${a.lastReconciled ? `last to ${formatDateText(a.lastReconciled)}` : 'never'})`).join(', ')}`
        : 'Every bank account with a statement is reconciled to the month end',
    },
    {
      key: 'PENDING_APPROVALS',
      severity: 'WARNING',
      ok: f.pendingApprovals === 0,
      count: f.pendingApprovals,
      label: 'Nothing waiting for approval',
      detail: f.pendingApprovals ? `${plural(f.pendingApprovals, 'request')} waiting for an approver` : 'No approval requests are waiting',
    },
    {
      key: 'EXPENSE_CLAIMS_WAITING',
      severity: 'WARNING',
      ok: f.submittedExpenseClaims === 0,
      count: f.submittedExpenseClaims,
      label: 'No expense claims waiting for a decision',
      detail: f.submittedExpenseClaims ? `${plural(f.submittedExpenseClaims, 'submitted expense claim')} not approved or rejected yet` : 'No submitted claims are waiting',
    },
    {
      key: 'PAYROLL_NOT_POSTED',
      severity: 'WARNING',
      ok: !f.payroll || f.payroll.posted,
      count: f.payroll && !f.payroll.posted ? 1 : 0,
      label: 'Payroll for the month is posted',
      detail: !f.payroll ? 'No active employees' : f.payroll.posted ? 'The pay run for the month is posted' : f.payroll.drafts ? `The pay run for ${f.period.name} is still a draft` : `There is no pay run for ${f.period.name}`,
    },
    {
      key: 'DEPRECIATION_MISSING',
      severity: 'WARNING',
      ok: !depreciationMissing,
      count: depreciationMissing ? 1 : 0,
      label: 'Depreciation is posted for the month',
      detail: assets.lte(0) ? 'No fixed assets in the books' : depreciationMissing ? `Fixed assets of ${money(assets)} but no depreciation posted in the month` : `${money(f.depreciation.postedThisMonth)} of depreciation posted`,
    },
    {
      key: 'DEFERRALS_NOT_POSTED',
      severity: 'WARNING',
      ok: f.deferrals.schedules === 0,
      count: f.deferrals.schedules,
      label: 'Prepaid and deferred revenue releases are posted',
      detail: f.deferrals.schedules ? `${money(f.deferrals.amount)} due to be released from ${plural(f.deferrals.schedules, 'schedule')} is not posted` : 'Nothing due to be released is waiting',
    },
    {
      key: 'NEGATIVE_CASH',
      severity: 'WARNING',
      ok: f.negativeCash.length === 0,
      count: f.negativeCash.length,
      label: 'No cash account below zero',
      detail: f.negativeCash.length ? `Below zero at the month end: ${f.negativeCash.map((a) => `${a.code} ${a.name} ${money(a.balance)}`).join(', ')}` : 'Every cash account is zero or more',
    },
    {
      key: 'AI_WAITING',
      severity: 'WARNING',
      ok: ai === 0,
      count: ai,
      label: 'No AI suggestions waiting for review',
      detail: ai
        ? [f.aiWaiting.adjustments ? `${plural(f.aiWaiting.adjustments, 'proposed adjusting entry', 'proposed adjusting entries')}` : null, f.aiWaiting.bankSuggestions ? `${plural(f.aiWaiting.bankSuggestions, 'bank suggestion')}` : null].filter(Boolean).join(' and ') + ' waiting for a person'
        : 'Nothing from the AI is waiting',
    },
    {
      key: 'EARLIER_PERIODS_OPEN',
      severity: 'WARNING',
      ok: f.earlierOpenPeriods.length === 0,
      count: f.earlierOpenPeriods.length,
      label: 'Earlier months are closed',
      detail: f.earlierOpenPeriods.length ? `Still open: ${f.earlierOpenPeriods.slice(0, 6).join(', ')}${f.earlierOpenPeriods.length > 6 ? ` and ${f.earlierOpenPeriods.length - 6} more` : ''}` : 'Every earlier month is locked',
    },
  ];
  return checks;
}

/**
 * Whether a month may be closed: every blocking check passes, and a failing warning needs a
 * note from the person closing saying why it is acceptable.
 */
export function closeReadiness(checks: CloseCheck[], note: string | null | undefined): { blocking: number; warnings: number; noteRequired: boolean; canClose: boolean; reason: string | null } {
  const blocking = checks.filter((c) => c.severity === 'BLOCKING' && !c.ok).length;
  const warnings = checks.filter((c) => c.severity === 'WARNING' && !c.ok).length;
  const noteRequired = warnings > 0;
  const noteOk = !noteRequired || (note ?? '').trim().length >= 10;
  const reason = blocking ? `${plural(blocking, 'blocking check')} not passed` : !noteOk ? `${plural(warnings, 'warning')} open: say why closing anyway is acceptable (at least 10 characters)` : null;
  return { blocking, warnings, noteRequired, canClose: !reason, reason };
}

// ------------------------------------------------------------------ AI review

/** What the model is shown about the month. */
export interface CloseReviewContext {
  currency: string;
  org: string;
  period: { name: string; startDate: string; endDate: string };
  /** The next period, where an accrual reverses; null when there is none yet. */
  nextPeriod: { name: string; startDate: string; open: boolean } | null;
  checks: { label: string; ok: boolean; detail: string }[];
  /**
   * Every account with activity this month or in the three before. movement is debits minus
   * credits in the month; priorAverage the same over the three months before, divided by 3;
   * monthsActive how many of those three had any posting.
   */
  accounts: { code: string; name: string; type: string; movement: string; priorAverage: string; monthsActive: number; closingBalance: string }[];
  /** Accounts an adjusting entry may use: postable, active, not bank, cash or a control account. */
  allowed: { code: string; id: string; name: string; type: string }[];
}

export interface AdjustmentInput {
  description: string;
  reason: string;
  confidence: Confidence;
  reverseNextPeriod: boolean;
  lines: { accountCode: string; debit?: string; credit?: string; description?: string }[];
}

export interface ResolvedAdjustment {
  date: string;
  description: string;
  lines: { accountId: string; accountCode: string; accountName: string; debit: string; credit: string; description: string }[];
  total: string;
  reverseOn: string | null;
}

export interface AdjustmentCheck {
  ok: boolean;
  label: string;
}

const AMOUNT = /^\d+(\.\d{1,2})?$/;
export const MAX_ADJUSTMENT_LINES = 10;

/**
 * Checks one proposed adjusting entry against what the model was shown: accounts it may use,
 * each line a debit or a credit of a plain positive amount, debits equal to credits, a short
 * description, and somewhere open to reverse it when it is an accrual.
 */
export function checkAdjustment(ctx: CloseReviewContext, a: AdjustmentInput): { checks: AdjustmentCheck[]; resolved: ResolvedAdjustment | null } {
  const money = (v: Dec | string) => formatAmountText(new D(v).toFixed(2), ctx.currency);
  const checks: AdjustmentCheck[] = [];
  const lines = a.lines ?? [];
  checks.push({ ok: lines.length >= 2 && lines.length <= MAX_ADJUSTMENT_LINES, label: lines.length < 2 ? 'An entry needs at least two lines' : lines.length > MAX_ADJUSTMENT_LINES ? `More than ${MAX_ADJUSTMENT_LINES} lines` : `${lines.length} lines` });

  const unknown: string[] = [];
  const bad: string[] = [];
  let debit = new D(0);
  let credit = new D(0);
  const resolved: ResolvedAdjustment['lines'] = [];
  for (const l of lines) {
    const acc = ctx.allowed.find((x) => x.code === l.accountCode);
    const label = acc?.code ?? (l.accountCode || '(none)');
    if (!acc) unknown.push(label);
    const d = (l.debit ?? '').trim();
    const c = (l.credit ?? '').trim();
    const isD = d !== '' && d !== '0' && d !== '0.00';
    const isC = c !== '' && c !== '0' && c !== '0.00';
    if (isD === isC) {
      bad.push(`${label}: a line is either a debit or a credit`);
      continue;
    }
    const v = isD ? d : c;
    if (!AMOUNT.test(v) || new D(v).lte(0)) {
      bad.push(`${label}: "${v}" is not an amount`);
      continue;
    }
    if (isD) debit = debit.plus(v);
    else credit = credit.plus(v);
    if (!acc) continue;
    resolved.push({ accountId: acc.id, accountCode: acc.code, accountName: acc.name, debit: isD ? new D(v).toFixed(2) : '0.00', credit: isC ? new D(v).toFixed(2) : '0.00', description: (l.description ?? '').trim().slice(0, 200) });
  }
  checks.push({ ok: unknown.length === 0, label: unknown.length ? `Accounts it may not use: ${unknown.join(', ')}` : `Posted to ${[...new Set(resolved.map((r) => `${r.accountCode} ${r.accountName}`))].join(', ')}` });
  checks.push({ ok: bad.length === 0, label: bad.length ? bad.join('; ') : 'Every line is a debit or a credit of an amount' });
  const balanced = debit.eq(credit) && debit.gt(0);
  checks.push({ ok: balanced, label: balanced ? `Debits equal credits (${money(debit)})` : `Debits ${money(debit)} and credits ${money(credit)} do not balance` });
  const description = (a.description ?? '').trim();
  checks.push({ ok: description.length > 0 && description.length <= 200 && !/[\r\n]/.test(description), label: 'A one-line description of up to 200 characters' });
  if (a.reverseNextPeriod) {
    const next = ctx.nextPeriod;
    checks.push({ ok: !!next?.open, label: next ? (next.open ? `Reversed on ${formatDateText(next.startDate)}, the first day of ${next.name}` : `${next.name} is locked, so the reversal cannot be posted`) : 'There is no next period to reverse it in: add the next fiscal year first' });
  }
  const ok = checks.every((c) => c.ok);
  return {
    checks,
    resolved: ok ? { date: ctx.period.endDate, description, lines: resolved, total: debit.toFixed(2), reverseOn: a.reverseNextPeriod ? ctx.nextPeriod!.startDate : null } : null,
  };
}

/** The month as the model reads it: plain text, account codes instead of ids. */
export function closeContextForModel(ctx: CloseReviewContext): string {
  const money = (v: string) => formatAmountText(new D(v).toFixed(2), ctx.currency);
  const signed = (v: string) => (new D(v).isNeg() ? `-${money(new D(v).abs().toFixed(2))}` : money(v));
  const pl = ctx.accounts.filter((a) => a.type === 'REVENUE' || a.type === 'EXPENSE');
  const bs = ctx.accounts.filter((a) => a.type !== 'REVENUE' && a.type !== 'EXPENSE');
  const row = (a: CloseReviewContext['accounts'][number]) => `- ${a.code} ${a.name} (${a.type.toLowerCase()}): this month ${signed(a.movement)}, average of the 3 months before ${signed(a.priorAverage)}, posted to in ${a.monthsActive} of those 3`;
  const usual = pl.filter((a) => a.monthsActive === 3 && new D(a.movement).isZero());
  return [
    `Month being closed: ${ctx.period.name} (${formatDateText(ctx.period.startDate)} to ${formatDateText(ctx.period.endDate)}) for "${ctx.org}". Amounts in ${ctx.currency}; debits are positive, credits negative.`,
    ctx.nextPeriod ? `Next period: ${ctx.nextPeriod.name}, starting ${formatDateText(ctx.nextPeriod.startDate)}${ctx.nextPeriod.open ? '' : ' (locked)'}.` : 'There is no next period yet, so nothing can be set to reverse.',
    '',
    'Month-end checklist:',
    ...ctx.checks.map((c) => `- ${c.ok ? 'OK' : 'OPEN'}: ${c.label}. ${c.detail}`),
    '',
    'Income and expense accounts:',
    ...(pl.length ? pl.map(row) : ['- none']),
    '',
    usual.length ? `Posted to in each of the 3 months before but nothing this month: ${usual.map((a) => `${a.code} ${a.name}`).join(', ')}.` : 'No account that is usually posted to every month is empty this month.',
    '',
    'Balance sheet accounts (closing balance at the month end):',
    ...(bs.length ? bs.map((a) => `${row(a)}, closing balance ${signed(a.closingBalance)}`) : ['- none']),
    '',
    'Accounts an adjusting entry may use (code, name, type):',
    ...ctx.allowed.map((a) => `- ${a.code} ${a.name} (${a.type.toLowerCase()})`),
  ].join('\n');
}

export function parseAdjustment(input: unknown): AdjustmentInput | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (typeof i.description !== 'string' || typeof i.reason !== 'string' || !i.reason.trim()) return null;
  if (typeof i.confidence !== 'string' || !(CONFIDENCE_LEVELS as readonly string[]).includes(i.confidence)) return null;
  if (!Array.isArray(i.lines)) return null;
  const lines = i.lines
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && typeof (l as Record<string, unknown>).accountCode === 'string')
    .slice(0, MAX_ADJUSTMENT_LINES + 1)
    .map((l) => ({
      accountCode: String(l.accountCode).trim(),
      debit: typeof l.debit === 'string' ? l.debit : typeof l.debit === 'number' ? String(l.debit) : undefined,
      credit: typeof l.credit === 'string' ? l.credit : typeof l.credit === 'number' ? String(l.credit) : undefined,
      description: typeof l.description === 'string' ? l.description.slice(0, 500) : undefined,
    }));
  return { description: i.description.slice(0, 500), reason: i.reason.trim().slice(0, 1000), confidence: i.confidence as Confidence, reverseNextPeriod: i.reverseNextPeriod === true, lines };
}
