import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { claimBudgetImpact, D, type Dec, departmentBudgets as computeBudgets, fiscalYearForDate, formatAmountText, minorUnits } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import type { OrgContext } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { departmentBudgets } from '../db/collections/department-budgets';
import { lineSums, postedBetween } from '../db/ledger-queries';

type Actor = { id: string };
const pad = (n: number) => String(n).padStart(2, '0');

/** The first and last day of a fiscal year, labelled by the calendar year it ends in. */
export function fiscalYearDates(fiscalYear: number, startMonth: number) {
  if (startMonth === 1) return { start: `${fiscalYear}-01-01`, end: `${fiscalYear}-12-31` };
  const start = `${fiscalYear - 1}-${pad(startMonth)}-01`;
  const next = new Date(Date.UTC(fiscalYear, startMonth - 1, 1) - 86_400_000);
  return { start, end: next.toISOString().slice(0, 10) };
}

/**
 * Department budgets (EXP-014): each department's budget for the fiscal year against what it has
 * spent (posted expense lines carrying the department) and what is waiting for approval, and what
 * a claim waiting for approval would do to it.
 */
@Injectable()
export class DepartmentBudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
  ) {}

  /** Active departments, for choosing one on an expense claim line. */
  async departments(org: OrgContext) {
    const values = await this.prisma.dimensionValue.findMany({ where: { orgId: org.id, type: 'DEPARTMENT', isActive: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } });
    return { departments: values };
  }

  /** Spent and committed per department in a fiscal year. */
  private async figures(org: OrgContext, fiscalYear: number, today: string) {
    const { start, end } = fiscalYearDates(fiscalYear, org.fiscalYearStartMonth);
    const upTo = today < end ? today : end;
    const expenseAccounts = (await this.prisma.account.findMany({ where: { orgId: org.id, type: 'EXPENSE' }, select: { id: true } })).map((a) => a.id);
    const spent = new Map<string, Dec>();
    if (expenseAccounts.length && upTo >= start) {
      const sums = await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(start), toDbDate(upTo), { excludeClosing: true }), line: { accountId: { $in: expenseAccounts }, departmentId: { $type: 'string' } }, by: { departmentId: 'lines.departmentId' } });
      for (const s of sums) if (s.key.departmentId) spent.set(s.key.departmentId as string, new D(s.debit).minus(s.credit));
    }
    const waiting = await this.prisma.expenseClaimLine.findMany({ where: { orgId: org.id, claim: { status: 'SUBMITTED', currency: org.functionalCurrency } }, select: { claimId: true, departmentId: true, netAmount: true } });
    const committed = new Map<string, Dec>();
    for (const l of waiting) if (l.departmentId) committed.set(l.departmentId, (committed.get(l.departmentId) ?? new D(0)).plus(l.netAmount.toString()));
    const budgets = await runInOrg(org.id, () => this.store.collection(departmentBudgets).find({ fiscalYear }));
    return { start, end, spent, committed, waiting, budgets: new Map(budgets.map((b) => [b.departmentId, b])) };
  }

  async report(org: OrgContext, fiscalYear?: number, today = todayIso()) {
    const fy = fiscalYear ?? fiscalYearForDate(today, org.fiscalYearStartMonth);
    const scale = minorUnits(org.functionalCurrency);
    const f = await this.figures(org, fy, today);
    const values = await this.prisma.dimensionValue.findMany({ where: { orgId: org.id, type: 'DEPARTMENT' }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, isActive: true } });
    const shown = values.filter((v) => v.isActive || f.budgets.has(v.id) || f.spent.has(v.id) || f.committed.has(v.id));
    const r = computeBudgets(
      shown.map((v) => ({ departmentId: v.id, code: v.code, name: v.name, budget: f.budgets.get(v.id)?.amount ?? null, actual: (f.spent.get(v.id) ?? new D(0)).toFixed(), committed: (f.committed.get(v.id) ?? new D(0)).toFixed() })),
      { fyStart: f.start, fyEnd: f.end, asOf: today, scale, money: (a) => formatAmountText(a, org.functionalCurrency) },
    );
    const notes = new Map([...f.budgets.values()].map((b) => [b.departmentId, b.note]));
    return {
      fiscalYear: fy,
      start: f.start,
      end: f.end,
      asOf: today,
      currency: org.functionalCurrency,
      ...r,
      rows: r.rows.map((x) => ({ ...x, note: notes.get(x.departmentId) ?? null })),
      canManage: hasPermission(org.role, 'budgets.manage'),
    };
  }

  async set(org: OrgContext, actor: Actor, input: { departmentId: string; fiscalYear: number; amount: string; note?: string | null }) {
    if (!hasPermission(org.role, 'budgets.manage')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot set department budgets; it needs budgets.manage`, HttpStatus.FORBIDDEN);
    const dep = await this.prisma.dimensionValue.findFirst({ where: { orgId: org.id, id: input.departmentId, type: 'DEPARTMENT' }, select: { id: true, name: true } });
    if (!dep) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Department not found' });
    const amount = new D(input.amount).toFixed(minorUnits(org.functionalCurrency));
    const col = this.store.collection(departmentBudgets);
    const before = await col.findOne({ departmentId: dep.id, fiscalYear: input.fiscalYear });
    const fields = { amount, note: input.note?.trim() || null, setById: actor.id, setAt: new Date() };
    if (before) await col.updateOne({ id: before.id }, { $set: fields });
    else await col.insertOne({ departmentId: dep.id, fiscalYear: input.fiscalYear, ...fields });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'department_budget.set', entityType: 'dimension_value', entityId: dep.id, data: { department: dep.name, fiscalYear: input.fiscalYear, amount: { from: before ? new D(before.amount).toFixed(minorUnits(org.functionalCurrency)) : null, to: amount }, note: fields.note } }),
    );
    return this.report(org, input.fiscalYear);
  }

  /** What approving a claim would do to the budget of each department on it. */
  async claimImpact(org: OrgContext, claimId: string, today = todayIso()) {
    const claim = await this.prisma.expenseClaim.findFirst({ where: { id: claimId, orgId: org.id }, select: { id: true, status: true, currency: true, lines: { select: { departmentId: true, netAmount: true } } } });
    if (!claim) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Claim not found' });
    const fy = fiscalYearForDate(today, org.fiscalYearStartMonth);
    const byDept = new Map<string, Dec>();
    for (const l of claim.lines) if (l.departmentId) byDept.set(l.departmentId, (byDept.get(l.departmentId) ?? new D(0)).plus(l.netAmount.toString()));
    if (!byDept.size || claim.currency !== org.functionalCurrency) return { fiscalYear: fy, departments: [] };
    const f = await this.figures(org, fy, today);
    const mine = new Map<string, Dec>();
    if (claim.status === 'SUBMITTED') for (const l of f.waiting) if (l.claimId === claim.id && l.departmentId) mine.set(l.departmentId, (mine.get(l.departmentId) ?? new D(0)).plus(l.netAmount.toString()));
    const values = await this.prisma.dimensionValue.findMany({ where: { orgId: org.id, id: { in: [...byDept.keys()] } }, select: { id: true, name: true } });
    const scale = minorUnits(org.functionalCurrency);
    const departments = claimBudgetImpact(
      values.map((v) => ({
        departmentId: v.id,
        name: v.name,
        budget: f.budgets.get(v.id)?.amount ?? null,
        actual: (f.spent.get(v.id) ?? new D(0)).toFixed(),
        committedOthers: (f.committed.get(v.id) ?? new D(0)).minus(mine.get(v.id) ?? 0).toFixed(),
      })),
      new Map([...byDept].map(([k, v]) => [k, v.toFixed()])),
      scale,
    );
    // An approved claim is already in what was spent: show where the budget stands, not a second charge.
    return { fiscalYear: fy, status: claim.status, departments: claim.status === 'SUBMITTED' ? departments : [] };
  }
}
