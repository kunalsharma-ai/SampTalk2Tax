/**
 * Segregation-of-duties checks (AUDIT-014). Approvals already stop one person giving both
 * approvals on a covered document; these checks look at what actually happened in the books over
 * a period and at who holds conflicting duties, and name each place one person did two jobs that
 * should be split. They only read: a finding is cleared by a reviewer who was not involved, with
 * a reason, never by changing the books.
 */

export const SOD_RULES = {
  SELF_POSTED_JOURNAL: {
    title: 'Journal prepared and posted by the same person',
    why: 'A manual journal moves money between accounts with nothing behind it but the person who wrote it. A second person posting it is the check.',
  },
  SELF_POSTED_BILL: {
    title: 'Bill entered and posted by the same person',
    why: 'Whoever enters a bill should not also be the one who makes it payable.',
  },
  SELF_APPROVED_PAYMENT_BATCH: {
    title: 'Payment batch approved by the person who prepared it',
    why: 'This is allowed only when no one else can approve. Each one should be looked at after the event.',
  },
  BANK_DETAILS_CHANGED_THEN_PAID: {
    title: 'Vendor bank details changed, then paid by the same person',
    why: 'Changing where a vendor is paid and then paying them is the usual shape of payment fraud.',
  },
  RECONCILED_OWN_PAYMENTS: {
    title: 'Bank reconciled by the person who recorded its payments',
    why: 'The reconciliation is the check on payments; it is weak when the person who made them does it.',
  },
} as const;
export type SodRule = keyof typeof SOD_RULES;
export const SOD_RULE_KEYS = Object.keys(SOD_RULES) as SodRule[];

/** Pairs of duties that should sit with different people, as permissions of the roles. */
export const SOD_DUTY_CONFLICTS = [
  { id: 'PREPARE_AND_POST_JOURNALS', title: 'Prepare and post journals', permissions: ['journals.create', 'journals.post'] },
  { id: 'VENDORS_AND_PAYMENTS', title: 'Set up vendors and pay them', permissions: ['contacts.manage', 'banking.manage'] },
  { id: 'PAY_AND_RECONCILE', title: 'Record bank payments and reconcile the bank', permissions: ['banking.manage', 'banking.reconcile'] },
  { id: 'PREPARE_AND_APPROVE', title: 'Prepare bills and payments and approve them', permissions: ['purchases.manage', 'approvals.decide'] },
  { id: 'PAYROLL_AND_POST', title: 'Prepare payroll and post it', permissions: ['payroll.manage', 'journals.post'] },
] as const;

export interface SodFacts {
  journals: { id: string; number: string | null; date: string; source: string; createdById: string; postedById: string | null; amount: string }[];
  bills: { id: string; number: string | null; date: string; contactId: string; createdById: string; postedById: string | null; amount: string }[];
  batches: { id: string; reference: string; date: string; createdById: string; approvedById: string | null; selfApproved: boolean; amount: string }[];
  bankDetailChanges: { contactId: string; changedById: string; changedAt: string }[];
  /** Vendor payments (money out) recorded in the period. */
  payments: { id: string; number: string; date: string; contactId: string; bankAccountId: string; createdById: string; amount: string; status: string }[];
  reconciliations: { id: string; accountId: string; startDate: string; statementDate: string; completedById: string; completedAt: string; status: string }[];
}

export interface SodFinding {
  /** Stable for the same event, so a review stays with it. */
  key: string;
  rule: SodRule;
  date: string;
  /** The people who did both jobs; none of them may clear it. */
  people: string[];
  subject: { type: 'journal' | 'bill' | 'payment_batch' | 'payment' | 'bank_reconciliation'; id: string; label: string };
  /** More about what happened, or empty when the check's title says it all. */
  detail: string;
  amount: string | null;
}

/** The findings for the period's facts, newest first. Dates are YYYY-MM-DD; changedAt and completedAt are ISO times. */
export function sodFindings(f: SodFacts): SodFinding[] {
  const out: SodFinding[] = [];
  for (const j of f.journals) {
    if (j.source === 'MANUAL' && j.postedById && j.postedById === j.createdById) {
      out.push({ key: `SELF_POSTED_JOURNAL:${j.id}`, rule: 'SELF_POSTED_JOURNAL', date: j.date, people: [j.createdById], subject: { type: 'journal', id: j.id, label: j.number ?? 'Journal' }, detail: '', amount: j.amount });
    }
  }
  for (const b of f.bills) {
    if (b.postedById && b.postedById === b.createdById) {
      out.push({ key: `SELF_POSTED_BILL:${b.id}`, rule: 'SELF_POSTED_BILL', date: b.date, people: [b.createdById], subject: { type: 'bill', id: b.id, label: b.number ?? 'Bill' }, detail: '', amount: b.amount });
    }
  }
  for (const b of f.batches) {
    if (b.selfApproved || (b.approvedById && b.approvedById === b.createdById)) {
      out.push({ key: `SELF_APPROVED_PAYMENT_BATCH:${b.id}`, rule: 'SELF_APPROVED_PAYMENT_BATCH', date: b.date, people: [b.createdById], subject: { type: 'payment_batch', id: b.id, label: b.reference }, detail: '', amount: b.amount });
    }
  }
  for (const p of f.payments) {
    if (p.status !== 'POSTED') continue;
    // The latest change to this vendor's details made by the payer on or before the payment.
    const change = f.bankDetailChanges
      .filter((c) => c.contactId === p.contactId && c.changedById === p.createdById && c.changedAt.slice(0, 10) <= p.date)
      .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))[0];
    if (change) {
      out.push({ key: `BANK_DETAILS_CHANGED_THEN_PAID:${p.id}`, rule: 'BANK_DETAILS_CHANGED_THEN_PAID', date: p.date, people: [p.createdById], subject: { type: 'payment', id: p.id, label: p.number }, detail: `Bank details changed on ${change.changedAt.slice(0, 10)} by the person who recorded this payment`, amount: p.amount });
    }
  }
  for (const r of f.reconciliations) {
    if (r.status !== 'COMPLETED') continue;
    const own = f.payments.filter((p) => p.status === 'POSTED' && p.bankAccountId === r.accountId && p.createdById === r.completedById && p.date >= r.startDate && p.date <= r.statementDate);
    if (own.length) {
      out.push({ key: `RECONCILED_OWN_PAYMENTS:${r.id}`, rule: 'RECONCILED_OWN_PAYMENTS', date: r.statementDate, people: [r.completedById], subject: { type: 'bank_reconciliation', id: r.id, label: `Reconciliation to ${r.statementDate}` }, detail: own.length === 1 ? 'A payment it covers was recorded by the same person' : `${own.length} payments it covers were recorded by the same person`, amount: null });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date < b.date ? 1 : -1));
}

/** The conflicting duties a set of permissions holds. */
export function dutyConflicts(has: (permission: string) => boolean) {
  return SOD_DUTY_CONFLICTS.filter((c) => c.permissions.every((p) => has(p))).map((c) => ({ id: c.id, title: c.title }));
}

/** Why a reviewer may not clear a finding, or null when they may. */
export function sodReviewIssue(finding: Pick<SodFinding, 'people'>, reviewerId: string, reason: string): string | null {
  if (finding.people.includes(reviewerId)) return 'Someone who did one of the jobs cannot clear the finding';
  if (reason.trim().length < 10) return 'Give a reason of at least 10 characters';
  return null;
}
