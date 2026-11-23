import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { categoryUsage, checkClaimCategories, CategoryClaimLine, CategoryViolation, ExpenseCategoryReceipt, expenseCategoryIssues, expenseCategoryKey, minorUnits } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { ExpenseCategoryDoc, expenseCategories } from '../db/collections/expense-categories';
import { expenseClaims } from '../db/collections/expenses';
import { organizations } from '../db/collections/tenancy';
import { ExpensePolicyService } from '../expenses/expense-policy.service';

export interface ExpenseCategoryBody {
  name: string;
  description?: string | null;
  accountId: string;
  taxRateId?: string | null;
  receipt: ExpenseCategoryReceipt;
}

/** A claim line as the claimant sends it: a category, or (finance only) an account. */
export interface CategoryLineInput {
  accountId?: string | null;
  categoryId?: string | null;
  taxRateId?: string | null;
  allowance?: unknown;
}

const USAGE_DAYS = 90;
const LIVE = ['SUBMITTED', 'APPROVED', 'REIMBURSED'] as const;

/**
 * Expense categories (EXP-005). MongoDB only. Finance (expenses.reimburse) keeps the list;
 * anyone who claims expenses sees the active ones. ExpensesService fills a line's account from
 * its category and checks the category's receipt rule with the expense policy.
 */
@Injectable()
export class ExpenseCategoriesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: ExpensePolicyService,
  ) {}

  /** Every category, for finance; the active ones for everyone else. */
  async list(org: OrgContext, opts: { all?: boolean } = {}) {
    const manage = hasPermission(org.role, 'expenses.reimburse');
    const rows = await this.store.collection(expenseCategories).find(manage && opts.all ? {} : { isActive: true }, { sort: { name: 1 } });
    const accIds = [...new Set(rows.map((r) => r.accountId))];
    const accs = accIds.length ? await this.store.collection(accounts).find({ id: { $in: accIds } }) : [];
    const accLabel = new Map(accs.map((a) => [a.id, `${a.code} · ${a.name}`]));
    const taxIds = [...new Set(rows.map((r) => r.taxRateId).filter((x): x is string => !!x))];
    const taxes = taxIds.length ? await this.prisma.taxRate.findMany({ where: { orgId: org.id, id: { in: taxIds } }, select: { id: true, name: true } }) : [];
    const taxName = new Map(taxes.map((t) => [t.id, t.name]));
    const base = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      accountId: r.accountId,
      account: accLabel.get(r.accountId) ?? null,
      taxRateId: r.taxRateId,
      taxRate: r.taxRateId ? (taxName.get(r.taxRateId) ?? null) : null,
      receipt: r.receipt,
      isActive: r.isActive,
      updatedAt: r.updatedAt.toISOString(),
    }));
    if (!manage && !hasPermission(org.role, 'expenses.read')) return { categories: base, usageDays: null };
    // What was claimed in each category lately, and the policy limits on its account.
    const since = new Date(Date.now() - USAGE_DAYS * 86_400_000); // not money
    const claims = await this.store.collection(expenseClaims).find({ status: { $in: [...LIVE] }, 'lines.categoryId': { $in: rows.map((r) => r.id) } }, { projection: { lines: 1 } });
    const usage = categoryUsage(
      claims.flatMap((c) => c.lines.filter((l) => l.date >= since).map((l) => ({ categoryId: l.categoryId ?? null, amount: String(l.amount) }))),
      minorUnits(org.functionalCurrency),
    );
    const rules = await this.policy.list(org, { activeOnly: true });
    return {
      usageDays: USAGE_DAYS,
      categories: base.map((c) => ({
        ...c,
        usage: usage.get(c.id) ?? { lines: 0, total: (0).toFixed(minorUnits(org.functionalCurrency)) },
        limits: rules.filter((r) => r.accountId === c.accountId).map((r) => ({ id: r.id, severity: r.severity, summary: r.summary })),
      })),
    };
  }

  private async valid(org: OrgContext, b: ExpenseCategoryBody, exceptId: string | null, active: boolean) {
    const others = await this.store.collection(expenseCategories).find({ isActive: true }, { projection: { id: 1, nameKey: 1 } });
    const taken = new Set(active ? others.filter((o) => o.id !== exceptId).map((o) => o.nameKey) : []);
    const issues = expenseCategoryIssues({ name: b.name, description: b.description ?? null, accountId: b.accountId, taxRateId: b.taxRateId ?? null, receipt: b.receipt }, taken);
    const a = b.accountId ? await this.store.collection(accounts).findById(b.accountId) : null;
    const o = await this.store.collection(organizations).findById(org.id);
    const control = new Set([o?.arAccountId, o?.apAccountId, o?.claimsAccountId].filter(Boolean));
    if (b.accountId && (!a || a.type !== 'EXPENSE' || !a.isPostable || !a.isActive || control.has(a.id))) issues.push('Choose an active expense account that can be posted to');
    if (b.taxRateId) {
      const t = await this.prisma.taxRate.findFirst({ where: { orgId: org.id, id: b.taxRateId }, select: { isActive: true, kind: true, purchaseAccountId: true } });
      if (!t || !t.isActive || t.kind !== 'SIMPLE' || !t.purchaseAccountId) issues.push('Choose an active tax rate that can be used on expense claims');
    }
    if (issues.length) throw new DomainError('CATEGORY_INVALID', 'The category is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const name = b.name.trim().replace(/\s+/g, ' ');
    return { name, nameKey: expenseCategoryKey(name), description: b.description?.trim() || null, accountId: b.accountId, taxRateId: b.taxRateId ?? null, receipt: b.receipt };
  }

  private async one(org: OrgContext, id: string) {
    const c = (await this.list(org, { all: true })).categories.find((x) => x.id === id);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense category not found' });
    return c;
  }

  private async row(id: string) {
    const r = await this.store.collection(expenseCategories).findById(id);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense category not found' });
    return r;
  }

  async create(org: OrgContext, actorId: string, b: ExpenseCategoryBody) {
    const v = await this.valid(org, b, null, true);
    const now = new Date();
    const r = await this.store.collection(expenseCategories).insertOne({ orgId: org.id, ...v, isActive: true, createdById: actorId, createdAt: now, updatedAt: now });
    await this.record(org.id, actorId, 'expense_category.created', r.id, { name: r.name, accountId: r.accountId, receipt: r.receipt });
    return this.one(org, r.id);
  }

  async update(org: OrgContext, actorId: string, id: string, b: ExpenseCategoryBody) {
    const before = await this.row(id);
    const v = await this.valid(org, b, id, before.isActive);
    const res = await this.store.collection(expenseCategories).updateOne({ id, updatedAt: before.updatedAt }, { $set: { ...v, updatedAt: new Date() } });
    if (!res.matched) throw new DomainError('CHANGED', 'The category changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    const changed = Object.fromEntries((['name', 'description', 'accountId', 'taxRateId', 'receipt'] as const).filter((k) => before[k] !== v[k]).map((k) => [k, { from: before[k], to: v[k] }]));
    await this.record(org.id, actorId, 'expense_category.updated', id, { name: v.name, changed });
    return this.one(org, id);
  }

  async setActive(org: OrgContext, actorId: string, id: string, isActive: boolean) {
    const before = await this.row(id);
    if (before.isActive === isActive) throw new DomainError(isActive ? 'ALREADY_ACTIVE' : 'ALREADY_ARCHIVED', isActive ? 'The category is already in use' : 'The category is already archived', HttpStatus.CONFLICT);
    if (isActive && (await this.store.collection(expenseCategories).findOne({ isActive: true, nameKey: before.nameKey }))) {
      throw new DomainError('CATEGORY_INVALID', 'The category is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues: [`There is already an active category called ${before.name}`] });
    }
    const res = await this.store.collection(expenseCategories).updateOne({ id, isActive: before.isActive }, { $set: { isActive, updatedAt: new Date() } });
    if (!res.matched) throw new DomainError('CHANGED', 'The category changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.record(org.id, actorId, isActive ? 'expense_category.restored' : 'expense_category.archived', id, { name: before.name });
    return this.one(org, id);
  }

  /**
   * Fills each line's account (and its default tax rate, when the line names none) from its
   * category. A category must be active; a line that names both must name the category's account.
   * Lines without a category are left as they are, for finance who claim to any expense account;
   * once an organisation has active categories, employees without expenses.read must pick one.
   */
  async resolveLines<L extends CategoryLineInput>(org: OrgContext, lines: L[]): Promise<L[]> {
    const ids = [...new Set(lines.map((l) => l.categoryId).filter((x): x is string => !!x))];
    const rows = ids.length ? await this.store.collection(expenseCategories).find({ id: { $in: ids } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const mustPick = !hasPermission(org.role, 'expenses.read') && (await this.store.collection(expenseCategories).count({ isActive: true })) > 0;
    const issues: string[] = [];
    const out = lines.map((l, i) => {
      if (!l.categoryId) {
        if (mustPick && !l.allowance) issues.push(`Line ${i + 1}: choose a category`);
        return l;
      }
      const c = byId.get(l.categoryId);
      if (!c) {
        issues.push(`Line ${i + 1}: category not found`);
        return l;
      }
      if (!c.isActive) issues.push(`Line ${i + 1}: ${c.name} is no longer a category; choose another`);
      if (l.allowance) issues.push(`Line ${i + 1}: a mileage or per diem line takes its account from its rate, not a category`);
      if (l.accountId && l.accountId !== c.accountId) issues.push(`Line ${i + 1}: the account is not the one ${c.name} posts to`);
      return { ...l, accountId: c.accountId, taxRateId: l.taxRateId === undefined ? c.taxRateId : l.taxRateId };
    });
    if (issues.length) throw new DomainError('CLAIM_INVALID', 'The claim is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return out;
  }

  /** The category rules a claim breaks, as policy violations (they block submission). */
  async violations(lines: CategoryClaimLine[], receiptCount: number): Promise<CategoryViolation[]> {
    const ids = [...new Set(lines.map((l) => l.categoryId).filter((x): x is string => !!x))];
    if (!ids.length) return [];
    const rows = await this.store.collection(expenseCategories).find({ id: { $in: ids } });
    return checkClaimCategories(lines, rows.map((r) => ({ id: r.id, name: r.name, accountId: r.accountId, receipt: r.receipt, isActive: r.isActive })), receiptCount);
  }

  /** Category names by id, archived ones included, for showing claim lines. */
  async names(ids: (string | null | undefined)[]): Promise<Map<string, ExpenseCategoryDoc>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.store.collection(expenseCategories).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((r) => [r.id, r]));
  }

  private record(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'expense_category', entityId, data }));
  }
}
