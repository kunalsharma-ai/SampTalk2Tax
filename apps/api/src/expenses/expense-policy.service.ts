import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { LineLimit, checkExpensePolicy, describeExpensePolicyRule, ExpensePolicyRule, expensePolicyRuleIssues, PolicyClaimLine, PolicyOtherLine, PolicyViolation, POLICY_KINDS_WITH_CATEGORY } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { ExpensePolicyRuleDoc, expensePolicyRules, PolicyKindName } from '../db/collections/expense-policy';
import { organizations } from '../db/collections/tenancy';

export interface PolicyRuleInput {
  kind: PolicyKindName;
  severity: 'WARN' | 'BLOCK';
  accountId?: string | null;
  amount?: string | null;
  days?: number | null;
}

/** The order rules are listed and checked in: the claim as a whole last. */
const ORDER: PolicyKindName[] = ['LINE_MAX', 'DAILY_MAX', 'MONTHLY_MAX', 'CLAIM_MAX', 'RECEIPT_ABOVE', 'MAX_AGE_DAYS'];

/**
 * Expense policy (EXP-013, EXP-015, EXP-022). MongoDB only. Finance (expenses.reimburse) sets
 * the rules; ExpensesService checks claims against the active ones when they are shown,
 * submitted (BLOCK rules refuse it) and approved (WARN rules need the approver's note).
 */
@Injectable()
export class ExpensePolicyService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async toRules(rows: ExpensePolicyRuleDoc[]): Promise<ExpensePolicyRule[]> {
    const ids = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x))];
    const accs = ids.length ? await this.store.collection(accounts).find({ id: { $in: ids } }) : [];
    const label = new Map(accs.map((a) => [a.id, `${a.code} · ${a.name}`]));
    return rows
      .map((r) => ({ id: r.id, kind: r.kind, severity: r.severity, accountId: r.accountId, accountLabel: r.accountId ? (label.get(r.accountId) ?? null) : null, amount: r.amount, days: r.days }))
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  }

  async list(org: OrgContext, opts: { activeOnly?: boolean } = {}) {
    const rows = await this.store.collection(expensePolicyRules).find(opts.activeOnly ? { isActive: true } : {}, { sort: { createdAt: 1 } });
    const rules = await this.toRules(rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rules.map((r) => ({ ...r, summary: describeExpensePolicyRule(r, org.functionalCurrency), isActive: byId.get(r.id)!.isActive, updatedAt: byId.get(r.id)!.updatedAt.toISOString() }));
  }

  private async check(org: OrgContext, input: PolicyRuleInput) {
    const rule = { kind: input.kind, severity: input.severity, accountId: input.accountId ?? null, amount: input.amount ?? null, days: input.days ?? null };
    const issues = expensePolicyRuleIssues(rule, org.functionalCurrency);
    if (!issues.length && rule.accountId && POLICY_KINDS_WITH_CATEGORY.includes(rule.kind)) {
      const a = await this.store.collection(accounts).findById(rule.accountId);
      const o = await this.store.collection(organizations).findById(org.id);
      const control = new Set([o?.arAccountId, o?.apAccountId, o?.claimsAccountId].filter(Boolean));
      if (!a || a.type !== 'EXPENSE' || !a.isPostable || control.has(a.id)) issues.push('Choose an expense category employees claim to');
    }
    if (issues.length) throw new DomainError('POLICY_RULE_INVALID', 'The rule is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return rule;
  }

  async create(org: OrgContext, actorId: string, input: PolicyRuleInput) {
    const rule = await this.check(org, input);
    const now = new Date();
    const r = await this.store.collection(expensePolicyRules).insertOne({ orgId: org.id, ...rule, isActive: true, createdById: actorId, createdAt: now, updatedAt: now });
    const out = (await this.list(org)).find((x) => x.id === r.id)!;
    await this.record(org.id, actorId, 'expense_policy_rule.created', r.id, { kind: r.kind, severity: r.severity, summary: out.summary });
    return out;
  }

  async update(org: OrgContext, actorId: string, id: string, input: Omit<PolicyRuleInput, 'kind'> & { isActive: boolean }) {
    const before = await this.store.collection(expensePolicyRules).findById(id);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Policy rule not found' });
    const rule = await this.check(org, { ...input, kind: before.kind });
    await this.store.collection(expensePolicyRules).updateOne({ id }, { $set: { severity: rule.severity, accountId: rule.accountId, amount: rule.amount, days: rule.days, isActive: input.isActive, updatedAt: new Date() } });
    const [was] = await this.toRules([before]);
    const out = (await this.list(org)).find((x) => x.id === id)!;
    await this.record(org.id, actorId, 'expense_policy_rule.updated', id, {
      before: { severity: before.severity, summary: describeExpensePolicyRule(was, org.functionalCurrency), isActive: before.isActive },
      after: { severity: out.severity, summary: out.summary, isActive: out.isActive },
    });
    return out;
  }

  private record(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'expense_policy_rule', entityId, data }));
  }

  /** The active per-receipt limits, for the anomaly checks. */
  async lineLimits(): Promise<LineLimit[]> {
    const rows = await this.store.collection(expensePolicyRules).find({ isActive: true, kind: 'LINE_MAX' });
    return rows.filter((r) => r.amount != null).map((r) => ({ accountId: r.accountId, amount: r.amount! }));
  }

  /** The active rules this claim breaks. */
  async violations(org: OrgContext, claim: { lines: PolicyClaimLine[]; receiptCount: number; asOf: string }, others: PolicyOtherLine[]): Promise<PolicyViolation[]> {
    const rows = await this.store.collection(expensePolicyRules).find({ isActive: true });
    if (!rows.length) return [];
    return checkExpensePolicy(await this.toRules(rows), claim, others, org.functionalCurrency);
  }
}
