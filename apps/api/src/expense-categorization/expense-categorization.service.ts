import { HttpStatus, Injectable } from '@nestjs/common';
import { addDays, suggestBillCoding, suggestExpenseCategory, type CategoryAccount, type CategoryHistoryLine, type CodingHistoryLine } from '@talk2tax/accounting-engine';
import { hasPermission, type Permission } from '@talk2tax/security';
import type { OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { expenseClaims } from '../db/collections/expenses';
import { contacts, documents } from '../db/collections/sales';
import { organizations } from '../db/collections/tenancy';

/** How far back earlier lines are read, and at most how many documents. */
const HISTORY_DAYS = 730;
const HISTORY_DOCS = 1000;

/**
 * Automatic expense categorisation (EXP-020 receipts, AP-020 bill lines) and bill coding (AP-026). MongoDB only; read-only.
 * Suggests the likely expense account from how this business booked the same merchant or vendor
 * before, the kind of spending the words name, and words seen on earlier lines. Nothing is booked.
 */
@Injectable()
export class ExpenseCategorizationService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  private require(org: OrgContext, permission: Permission, what: string) {
    if (!hasPermission(org.role, permission)) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${permission}`, HttpStatus.FORBIDDEN);
  }

  /** Postable, active expense accounts, without the receivables, payables and claims control accounts. */
  private async expenseAccounts(org: OrgContext): Promise<CategoryAccount[]> {
    const o = await this.store.collection(organizations).findById(org.id);
    const control = [o?.arAccountId, o?.apAccountId, o?.claimsAccountId].filter((x): x is string => !!x);
    const rows = await this.store.collection(accounts).find({ type: 'EXPENSE', isPostable: true, isActive: true, id: { $nin: control } }, { projection: { id: 1, code: 1, name: 1 }, sort: { code: 1 } });
    return rows.map((a) => ({ id: a.id, code: a.code, name: a.name }));
  }

  /** A receipt line on an expense claim: history from approved and reimbursed claims. */
  async forClaimLine(org: OrgContext, q: { merchant?: string | null; description?: string | null }) {
    this.require(org, 'expenses.submit', 'claim expenses');
    const since = toDbDate(addDays(todayIso(), -HISTORY_DAYS));
    const [accs, claims] = await Promise.all([
      this.expenseAccounts(org),
      this.store.collection(expenseClaims).find({ status: { $in: ['APPROVED', 'REIMBURSED'] }, postingDate: { $gte: since } }, { projection: { lines: 1 }, sort: { postingDate: -1 }, limit: HISTORY_DOCS }),
    ]);
    const history: CategoryHistoryLine[] = claims.flatMap((c) => c.lines.map((l) => ({ merchant: l.merchant ?? null, description: l.description ?? null, accountId: l.accountId })));
    return { suggestions: suggestExpenseCategory({ merchant: q.merchant, description: q.description, accounts: accs, history }), linesRead: history.length };
  }

  /** A bill line: the vendor's name stands for the merchant; history from posted bills. */
  async forBillLine(org: OrgContext, q: { contactId?: string | null; description?: string | null }) {
    this.require(org, 'purchases.read', 'see bills');
    const since = toDbDate(addDays(todayIso(), -HISTORY_DAYS));
    const [accs, bills, vendor] = await Promise.all([
      this.expenseAccounts(org),
      this.store.collection(documents).find({ kind: 'BILL', status: 'POSTED', issueDate: { $gte: since } }, { projection: { contactId: 1, lines: 1 }, sort: { issueDate: -1 }, limit: HISTORY_DOCS }),
      q.contactId ? this.store.collection(contacts).findById(q.contactId) : null,
    ]);
    const names = new Map((await this.store.collection(contacts).find({ id: { $in: [...new Set(bills.map((b) => b.contactId))] } }, { projection: { id: 1, name: 1 } })).map((c) => [c.id, c.name]));
    const history: CategoryHistoryLine[] = bills.flatMap((b) => b.lines.map((l) => ({ merchant: names.get(b.contactId) ?? null, description: l.description ?? null, accountId: l.accountId })));
    return { suggestions: suggestExpenseCategory({ merchant: vendor?.name ?? null, description: q.description, accounts: accs, history }), linesRead: history.length };
  }

  /**
   * Codes every line of a vendor's bill (AP-026): the account, then the tax rate, department and
   * project most of the vendor's earlier lines on that account had. Only active rates and values.
   */
  async billCoding(org: OrgContext, q: { contactId: string; lines: { lineNo: number; description?: string | null }[] }) {
    this.require(org, 'purchases.read', 'see bills');
    const vendor = await this.store.collection(contacts).findById(q.contactId);
    if (!vendor) throw new DomainError('NOT_FOUND', 'Vendor not found', HttpStatus.NOT_FOUND);
    const since = toDbDate(addDays(todayIso(), -HISTORY_DAYS));
    const [accs, bills, rates, dims] = await Promise.all([
      this.expenseAccounts(org),
      this.store.collection(documents).find({ kind: 'BILL', status: 'POSTED', issueDate: { $gte: since } }, { projection: { contactId: 1, lines: 1 }, sort: { issueDate: -1 }, limit: HISTORY_DOCS }),
      this.prisma.taxRate.findMany({ where: { orgId: org.id, isActive: true }, select: { id: true, name: true } }),
      this.prisma.dimensionValue.findMany({ where: { orgId: org.id, isActive: true }, select: { id: true, name: true, type: true } }),
    ]);
    const names = new Map((await this.store.collection(contacts).find({ id: { $in: [...new Set(bills.map((b) => b.contactId))] } }, { projection: { id: 1, name: 1 } })).map((c) => [c.id, c.name]));
    const history: CategoryHistoryLine[] = bills.flatMap((b) => b.lines.map((l) => ({ merchant: names.get(b.contactId) ?? null, description: l.description ?? null, accountId: l.accountId })));
    const taxRates = new Map(rates.map((r) => [r.id, r.name]));
    const departments = new Map(dims.filter((d) => d.type === 'DEPARTMENT').map((d) => [d.id, d.name]));
    const projects = new Map(dims.filter((d) => d.type === 'PROJECT').map((d) => [d.id, d.name]));
    // Earlier lines keep only rates and values still in use, so nothing inactive is suggested.
    const vendorHistory: CodingHistoryLine[] = bills
      .filter((b) => b.contactId === vendor.id)
      .flatMap((b) => b.lines.map((l) => ({ description: l.description ?? null, accountId: l.accountId, taxRateId: l.taxRateId && taxRates.has(l.taxRateId) ? l.taxRateId : null, departmentId: l.departmentId && departments.has(l.departmentId) ? l.departmentId : null, projectId: l.projectId && projects.has(l.projectId) ? l.projectId : null })));
    const lines = suggestBillCoding({ vendor: vendor.name, lines: q.lines.map((l) => ({ lineNo: l.lineNo, description: l.description ?? null })), accounts: accs, history, vendorHistory, labels: { taxRates, departments, projects } });
    return { vendor: vendor.name, vendorLines: vendorHistory.length, lines };
  }
}
