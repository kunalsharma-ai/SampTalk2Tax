import { HttpStatus, Injectable } from '@nestjs/common';
import { expenseReport, minorUnits, type ExpenseGroup } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { accounts } from '../db/collections/chart';
import { ExpenseClaimStatusName, expenseClaims } from '../db/collections/expenses';
import { users } from '../db/collections/identity';

export const REPORTABLE_STATUSES = ['SUBMITTED', 'APPROVED', 'REIMBURSED'] as const;
export type ReportableStatus = (typeof REPORTABLE_STATUSES)[number];

export interface ExpenseReportQuery {
  from: string;
  to: string;
  statuses?: ReportableStatus[];
  claimantId?: string;
  accountId?: string;
}

/**
 * Expense reports (EXP-017): claim lines by category, month, person, status and merchant over a
 * period. MongoDB only. expenses.read sees everyone's; a claimant with only expenses.submit sees
 * their own. Drafts, rejected and void claims are left out: they are not spending.
 */
@Injectable()
export class ExpenseReportService {
  constructor(private readonly store: DocumentStoreService) {}

  async report(org: OrgContext, actorId: string, q: ExpenseReportQuery) {
    const all = hasPermission(org.role, 'expenses.read');
    if (!all && !hasPermission(org.role, 'expenses.submit')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot see expense reports; it needs expenses.read`, HttpStatus.FORBIDDEN);
    if (q.from > q.to) throw new DomainError('BAD_RANGE', 'The period starts after it ends', HttpStatus.UNPROCESSABLE_ENTITY);
    const statuses: ExpenseClaimStatusName[] = q.statuses?.length ? q.statuses : [...REPORTABLE_STATUSES];
    const claimantId = all ? q.claimantId : actorId;
    const claims = await this.store.collection(expenseClaims).find({
      status: { $in: statuses },
      ...(claimantId ? { claimantId } : {}),
      lines: { $elemMatch: { date: { $gte: toDbDate(q.from), $lte: toDbDate(q.to) } } },
    });
    const lines = claims.flatMap((c) =>
      c.lines
        .filter((l) => !q.accountId || l.accountId === q.accountId)
        .map((l) => ({ claimId: c.id, claimantId: c.claimantId, status: c.status, date: fromDbDate(l.date), accountId: l.accountId, merchant: l.merchant, net: l.netAmount, tax: l.taxAmount, amount: l.amount })),
    );
    const r = expenseReport(lines, q.from, q.to);
    const [accts, people] = await Promise.all([
      r.byCategory.length ? this.store.collection(accounts).find({ id: { $in: r.byCategory.map((g) => g.key) } }) : [],
      r.byPerson.length ? this.store.collection(users).find({ id: { $in: r.byPerson.map((g) => g.key) } }) : [],
    ]);
    const acct = new Map(accts.map((a) => [a.id, a]));
    const person = new Map(people.map((u) => [u.id, u.name]));
    const scale = minorUnits(org.functionalCurrency);
    const g = (x: ExpenseGroup) => ({ claims: x.claims, lines: x.lines, net: x.net.toFixed(scale), tax: x.tax.toFixed(scale), total: x.total.toFixed(scale), share: x.share });
    return {
      from: q.from,
      to: q.to,
      currency: org.functionalCurrency,
      scope: all ? 'all' : 'mine',
      statuses,
      totals: { claims: r.totals.claims, lines: r.totals.lines, net: r.totals.net.toFixed(scale), tax: r.totals.tax.toFixed(scale), total: r.totals.total.toFixed(scale) },
      byCategory: r.byCategory.map((x) => ({ accountId: x.key, code: acct.get(x.key)?.code ?? null, name: acct.get(x.key)?.name ?? 'Unknown account', ...g(x) })),
      byMonth: r.byMonth.map((x) => ({ month: x.key, ...g(x) })),
      byPerson: r.byPerson.map((x) => ({ claimantId: x.key, name: person.get(x.key) ?? 'Former member', ...g(x) })),
      byStatus: r.byStatus.map((x) => ({ status: x.key, ...g(x) })),
      byMerchant: r.byMerchant.map((x) => ({ merchant: x.key, ...g(x) })),
    };
  }
}
