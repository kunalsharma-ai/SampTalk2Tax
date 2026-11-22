/**
 * Automated audit evidence for expense claims (EXP-027): for every decided claim, the evidence an
 * auditor asks for, collected from the records themselves, and what is missing.
 *
 * Items, each OK, NOTED (an exception with its reason on record), GAP, PENDING (not due yet) or NA:
 * - RECEIPTS: at least one receipt file on the claim (each with its SHA-256). Otherwise a gap.
 * - APPROVAL: approved by someone other than the claimant, with the time.
 * - POLICY: within the expense policy when approved; outside it with the approver's note is NOTED.
 * - POSTING: the claim's journal entry is posted.
 * - PAYMENT: reimbursed (date, account, journal); approved and unpaid is pending; void is NA.
 * - BANK: the reimbursement is matched on the bank statement. Not matched while the statement runs
 *   past the payment date by more than BANK_GRACE_DAYS is a gap; otherwise pending. Cash: NA.
 * - AUDIT_TRAIL: the approval (and the reimbursement or void, when made) is in the hash-chained
 *   audit trail.
 * A claim is complete when no item is a gap.
 */
import { addDays } from './documents';

export const EVIDENCE_BANK_GRACE_DAYS = 3;
export const EXPENSE_EVIDENCE_KINDS = ['RECEIPTS', 'APPROVAL', 'POLICY', 'POSTING', 'PAYMENT', 'BANK', 'AUDIT_TRAIL'] as const;
export type ExpenseEvidenceKind = (typeof EXPENSE_EVIDENCE_KINDS)[number];
export const EXPENSE_EVIDENCE_LABEL: Record<ExpenseEvidenceKind, string> = {
  RECEIPTS: 'Receipts',
  APPROVAL: 'Approval',
  POLICY: 'Expense policy',
  POSTING: 'Journal entry',
  PAYMENT: 'Reimbursement',
  BANK: 'Bank statement',
  AUDIT_TRAIL: 'Audit trail',
};
export type EvidenceState = 'OK' | 'NOTED' | 'GAP' | 'PENDING' | 'NA';

export interface EvidenceClaim {
  status: 'APPROVED' | 'REIMBURSED' | 'VOID';
  claimantId: string;
  approvedOn: string | null;
  approver: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Policy rules the claim broke when approved, from the audit trail. */
  policyExceptions: string[];
  receipts: { fileName: string; sha256: string }[];
  journal: { number: string; posted: boolean } | null;
  reimbursement: { date: string; account: string; cash: boolean; journal: string | null; onStatement: boolean; statementThrough: string | null } | null;
  voided: { date: string; reason: string } | null;
  auditActions: string[];
}

export interface EvidenceItem {
  kind: ExpenseEvidenceKind;
  label: string;
  state: EvidenceState;
  detail: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function collectExpenseEvidence(c: EvidenceClaim): { items: EvidenceItem[]; complete: boolean; gaps: ExpenseEvidenceKind[] } {
  const items: EvidenceItem[] = [];
  const add = (kind: ExpenseEvidenceKind, state: EvidenceState, detail: string) => items.push({ kind, label: EXPENSE_EVIDENCE_LABEL[kind], state, detail });

  add('RECEIPTS', c.receipts.length ? 'OK' : 'GAP', c.receipts.length ? `${plural(c.receipts.length, 'file', 'files')} attached, each with its SHA-256 checksum` : 'No receipt is attached to the claim');

  if (c.approver && c.approver.id !== c.claimantId) add('APPROVAL', 'OK', `Approved by ${c.approver.name}${c.decidedAt ? ` at ${c.decidedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}${c.approvedOn ? `, posted on ${c.approvedOn}` : ''}`);
  else add('APPROVAL', 'GAP', c.approver ? 'Approved by the claimant themselves' : 'No approver on record');

  if (!c.policyExceptions.length) add('POLICY', 'OK', 'Within the expense policy when approved');
  else if (c.decisionNote?.trim()) add('POLICY', 'NOTED', `Approved outside the policy (${c.policyExceptions.join('; ')}) with the note: "${c.decisionNote.trim()}"`);
  else add('POLICY', 'GAP', `Approved outside the policy (${c.policyExceptions.join('; ')}) without a note`);

  add('POSTING', c.journal?.posted ? 'OK' : 'GAP', c.journal ? (c.journal.posted ? `Posted as ${c.journal.number}` : `${c.journal.number} is not posted`) : 'No journal entry on record');

  if (c.status === 'VOID') {
    add('PAYMENT', 'NA', c.voided ? `Voided on ${c.voided.date}: ${c.voided.reason}` : 'Voided');
    add('BANK', 'NA', 'Not paid');
  } else if (!c.reimbursement) {
    add('PAYMENT', 'PENDING', 'Approved, not reimbursed yet');
    add('BANK', 'NA', 'Not paid yet');
  } else {
    const r = c.reimbursement;
    add('PAYMENT', r.journal ? 'OK' : 'GAP', r.journal ? `Reimbursed on ${r.date} from ${r.account} (${r.journal})` : `Reimbursed on ${r.date} but no journal entry is on record`);
    if (r.cash) add('BANK', 'NA', 'Paid in cash: no bank statement');
    else if (r.onStatement) add('BANK', 'OK', `Matched on the ${r.account} statement`);
    else if (r.statementThrough && r.statementThrough > addDays(r.date, EVIDENCE_BANK_GRACE_DAYS)) add('BANK', 'GAP', `Not matched on the statement, which runs to ${r.statementThrough}`);
    else add('BANK', 'PENDING', r.statementThrough ? `The statement runs only to ${r.statementThrough}` : `No statement imported for ${r.account} yet`);
  }

  const needed = ['expense_claim.approved', ...(c.status === 'REIMBURSED' ? ['expense_claim.reimbursed'] : []), ...(c.status === 'VOID' ? ['expense_claim.voided'] : [])];
  const missing = needed.filter((a) => !c.auditActions.includes(a));
  add('AUDIT_TRAIL', missing.length ? 'GAP' : 'OK', missing.length ? `Missing from the audit trail: ${missing.map((a) => a.split('.')[1]).join(', ')}` : `${plural(c.auditActions.length, 'event', 'events')} in the hash-chained audit trail`);

  const gaps = items.filter((i) => i.state === 'GAP').map((i) => i.kind);
  return { items, complete: !gaps.length, gaps };
}

/** One CSV row per evidence item and receipt file: the index an auditor works from. */
export function expenseEvidenceCsv(rows: { number: string; claimant: string; status: string; total: string; items: EvidenceItem[]; receipts: { fileName: string; sha256: string }[] }[]): string {
  const q = (v: string) => (/[",\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  const out = [['Claim', 'Claimant', 'Status', 'Total', 'Evidence', 'State', 'Detail', 'File', 'SHA-256'].join(',')];
  for (const r of rows) {
    for (const i of r.items) out.push([r.number, r.claimant, r.status, r.total, i.label, i.state, i.detail, '', ''].map(q).join(','));
    for (const f of r.receipts) out.push([r.number, r.claimant, r.status, r.total, 'Receipt file', 'OK', '', f.fileName, f.sha256].map(q).join(','));
  }
  return `${out.join('\n')}\n`;
}
