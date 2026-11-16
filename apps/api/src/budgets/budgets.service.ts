import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  BUDGET_PERIODS,
  BudgetAccountType,
  BudgetGranularity,
  budgetAmountsIssue,
  buildBudgetVariance,
  D,
  Dec,
  fiscalYearForDate,
  fromPriorYear,
  generateFiscalYear,
  minorUnits,
  sum,
} from '@talk2tax/accounting-engine';
import { Budget, BudgetStatus, Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { PrismaService } from '../common/prisma.service';

type Tx = Prisma.TransactionClient;
type Actor = { id: string };

export type CreateBudgetInput =
  | { fiscalYear: number; name: string; note?: string | null; basis: 'EMPTY' }
  | { fiscalYear: number; name: string; note?: string | null; basis: 'COPY'; sourceBudgetId: string }
  | { fiscalYear: number; name: string; note?: string | null; basis: 'PRIOR_ACTUALS'; changePercent: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;

interface ActualRow {
  account_id: string;
  month: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  // ------------------------------------------------------------------ helpers

  private async org(orgId: string) {
    return this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true, fiscalYearStartMonth: true } });
  }

  /** The twelve months of a fiscal year, from the organisation's start month (not the fiscal_periods table). */
  periods(fiscalYear: number, startMonth: number) {
    return generateFiscalYear(fiscalYear, startMonth).map((p) => ({ periodNo: p.periodNo, label: monthLabel(p.startDate), startDate: p.startDate, endDate: p.endDate }));
  }

  private async load(orgId: string, id: string, tx: Tx | PrismaService = this.prisma) {
    const b = await tx.budget.findFirst({ where: { id, orgId } });
    if (!b) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Budget not found' });
    return b;
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private header(b: Budget, who: Map<string, string>) {
    const person = (id: string | null) => (id ? { id, name: who.get(id) ?? 'Former member' } : null);
    return {
      id: b.id,
      fiscalYear: b.fiscalYear,
      version: b.version,
      name: b.name,
      note: b.note,
      basis: b.basis,
      sourceBudgetId: b.sourceBudgetId,
      changePercent: b.changePercent?.toFixed(2) ?? null,
      status: b.status,
      createdBy: person(b.createdById),
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
      submittedBy: person(b.submittedById),
      submittedAt: b.submittedAt?.toISOString() ?? null,
      approvedBy: person(b.approvedById),
      approvedAt: b.approvedAt?.toISOString() ?? null,
      supersededAt: b.supersededAt?.toISOString() ?? null,
      returned: b.returnedAt ? { by: person(b.returnedById), at: b.returnedAt.toISOString(), reason: b.returnReason } : null,
    };
  }

  /** Revenue and expense totals per budget, by account type. */
  private async totals(orgId: string, ids: string[]) {
    if (!ids.length) return new Map<string, { revenue: Dec; expenses: Dec; accounts: number }>();
    const lines = await this.prisma.budgetLine.findMany({ where: { orgId, budgetId: { in: ids } }, select: { budgetId: true, accountId: true, amount: true, account: { select: { type: true } } } });
    const grouped = new Map<string, { budget_id: string; type: string; amount: Prisma.Decimal; ids: Set<string> }>();
    for (const l of lines) {
      const k = `${l.budgetId}|${l.account.type}`;
      const g = grouped.get(k) ?? { budget_id: l.budgetId, type: l.account.type as string, amount: new Prisma.Decimal(0), ids: new Set<string>() };
      g.amount = g.amount.plus(l.amount);
      g.ids.add(l.accountId);
      grouped.set(k, g);
    }
    const rows = [...grouped.values()].map((g) => ({ ...g, accounts: g.ids.size }));
    const out = new Map<string, { revenue: Dec; expenses: Dec; accounts: number }>();
    for (const id of ids) out.set(id, { revenue: new D(0), expenses: new D(0), accounts: 0 });
    for (const r of rows) {
      const t = out.get(r.budget_id)!;
      if (r.type === 'REVENUE') t.revenue = t.revenue.plus(r.amount.toFixed());
      else t.expenses = t.expenses.plus(r.amount.toFixed());
      t.accounts += Number(r.accounts);
    }
    return out;
  }

  /** Posted revenue and expense movements by account and month, on each account's normal side. */
  async actuals(orgId: string, from: string, to: string, tx: Tx | PrismaService = this.prisma) {
    const accounts = new Map((await tx.account.findMany({ where: { orgId, type: { in: ['REVENUE', 'EXPENSE'] } }, select: { id: true, type: true } })).map((a) => [a.id, a.type as string]));
    const sums = accounts.size
      ? await lineSums(this.store, orgId, { entry: postedBetween(toDbDate(from), toDbDate(to), { excludeClosing: true }), line: { accountId: { $in: [...accounts.keys()] } }, by: { accountId: 'lines.accountId', month: { $dateToString: { date: '$date', format: '%Y-%m' } } } })
      : [];
    const rows = sums.map((r) => ({ account_id: r.key.accountId as string, month: r.key.month as string, type: accounts.get(r.key.accountId as string)!, debit: r.debit, credit: r.credit }));
    const byAccount = new Map<string, Map<string, Dec>>();
    for (const r of rows) {
      const net = new D(r.debit.toFixed()).minus(r.credit.toFixed());
      const amount = r.type === 'REVENUE' ? net.negated() : net;
      if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, new Map());
      byAccount.get(r.account_id)!.set(r.month, amount);
    }
    return byAccount;
  }

  // ------------------------------------------------------------------ reading

  /** The fiscal years worth offering: last year, this year and next, plus any year that has a budget. */
  async overview(orgId: string, fiscalYear?: number) {
    const o = await this.org(orgId);
    const current = fiscalYearForDate(todayIso(), o.fiscalYearStartMonth);
    const withBudgets = await this.prisma.budget.findMany({ where: { orgId }, distinct: ['fiscalYear'], select: { fiscalYear: true } });
    const years = [...new Set([current - 1, current, current + 1, ...withBudgets.map((b) => b.fiscalYear)])].sort((a, b) => b - a);
    const year = fiscalYear ?? current;
    const list = await this.prisma.budget.findMany({ where: { orgId, fiscalYear: year }, orderBy: { version: 'desc' } });
    const [who, totals] = await Promise.all([this.names(list.flatMap((b) => [b.createdById, b.submittedById, b.approvedById, b.returnedById])), this.totals(orgId, list.map((b) => b.id))]);
    const scale = minorUnits(o.functionalCurrency);
    const periods = this.periods(year, o.fiscalYearStartMonth);
    return {
      currency: o.functionalCurrency,
      currentFiscalYear: current,
      fiscalYear: year,
      years: years.map((y) => {
        const p = this.periods(y, o.fiscalYearStartMonth);
        return { fiscalYear: y, label: `FY${y}`, from: p[0].startDate, to: p[11].endDate };
      }),
      from: periods[0].startDate,
      to: periods[11].endDate,
      budgets: list.map((b) => {
        const t = totals.get(b.id)!;
        return { ...this.header(b, who), accounts: t.accounts, revenue: t.revenue.toFixed(scale), expenses: t.expenses.toFixed(scale), netIncome: t.revenue.minus(t.expenses).toFixed(scale) };
      }),
    };
  }

  async get(orgId: string, id: string) {
    const o = await this.org(orgId);
    const b = await this.load(orgId, id);
    const [lines, accounts, who] = await Promise.all([
      this.prisma.budgetLine.findMany({ where: { orgId, budgetId: id } }),
      this.prisma.account.findMany({ where: { orgId, type: { in: ['REVENUE', 'EXPENSE'] }, isPostable: true }, orderBy: { code: 'asc' } }),
      this.names([b.createdById, b.submittedById, b.approvedById, b.returnedById]),
    ]);
    const scale = minorUnits(o.functionalCurrency);
    const amounts = new Map<string, string[]>();
    for (const l of lines) {
      if (!amounts.has(l.accountId)) amounts.set(l.accountId, Array.from({ length: BUDGET_PERIODS }, () => (0).toFixed(scale)));
      amounts.get(l.accountId)![l.periodNo - 1] = l.amount.toFixed(scale);
    }
    const rows = accounts
      .filter((a) => a.isActive || amounts.has(a.id))
      .map((a) => {
        const m = amounts.get(a.id) ?? null;
        return { accountId: a.id, code: a.code, name: a.name, type: a.type as BudgetAccountType, isActive: a.isActive, amounts: m, total: m ? sum(m.map((x) => new D(x))).toFixed(scale) : null };
      });
    const monthTotals = (type: BudgetAccountType) =>
      Array.from({ length: BUDGET_PERIODS }, (_, i) => sum(rows.filter((r) => r.type === type && r.amounts).map((r) => new D(r.amounts![i]))));
    const rev = monthTotals('REVENUE');
    const exp = monthTotals('EXPENSE');
    const source = b.sourceBudgetId ? await this.prisma.budget.findFirst({ where: { id: b.sourceBudgetId, orgId }, select: { id: true, fiscalYear: true, version: true, name: true } }) : null;
    return {
      currency: o.functionalCurrency,
      budget: this.header(b, who),
      source,
      periods: this.periods(b.fiscalYear, o.fiscalYearStartMonth),
      rows,
      totals: {
        revenue: rev.map((x) => x.toFixed(scale)),
        expenses: exp.map((x) => x.toFixed(scale)),
        netIncome: rev.map((x, i) => x.minus(exp[i]).toFixed(scale)),
        year: { revenue: sum(rev).toFixed(scale), expenses: sum(exp).toFixed(scale), netIncome: sum(rev).minus(sum(exp)).toFixed(scale) },
      },
    };
  }

  // ------------------------------------------------------------------ versions

  async create(orgId: string, actor: Actor, input: CreateBudgetInput) {
    const o = await this.org(orgId);
    const scale = minorUnits(o.functionalCurrency);
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`budget:${orgId}:${input.fiscalYear}`}))`;
      const last = await tx.budget.findFirst({ where: { orgId, fiscalYear: input.fiscalYear }, orderBy: { version: 'desc' }, select: { version: true } });
      const version = (last?.version ?? 0) + 1;
      let lines: { accountId: string; amounts: string[] }[] = [];
      if (input.basis === 'COPY') {
        const src = await this.load(orgId, input.sourceBudgetId, tx);
        const srcLines = await tx.budgetLine.findMany({ where: { orgId, budgetId: src.id }, include: { account: { select: { isPostable: true } } } });
        const m = new Map<string, string[]>();
        for (const l of srcLines) {
          if (!l.account.isPostable) continue;
          if (!m.has(l.accountId)) m.set(l.accountId, Array.from({ length: BUDGET_PERIODS }, () => '0'));
          m.get(l.accountId)![l.periodNo - 1] = l.amount.toFixed(scale);
        }
        lines = [...m].map(([accountId, amounts]) => ({ accountId, amounts }));
      } else if (input.basis === 'PRIOR_ACTUALS') {
        const prior = this.periods(input.fiscalYear - 1, o.fiscalYearStartMonth);
        const actual = await this.actuals(orgId, prior[0].startDate, prior[11].endDate, tx);
        const postable = new Set((await tx.account.findMany({ where: { orgId, isPostable: true, type: { in: ['REVENUE', 'EXPENSE'] } }, select: { id: true } })).map((a) => a.id));
        for (const [accountId, months] of actual) {
          if (!postable.has(accountId)) continue;
          const monthly = prior.map((p) => months.get(p.startDate.slice(0, 7)) ?? new D(0));
          if (monthly.every((x) => x.isZero())) continue;
          lines.push({ accountId, amounts: fromPriorYear(monthly, input.changePercent, scale) });
        }
        if (!lines.length) throw new DomainError('NO_PRIOR_ACTUALS', `FY${input.fiscalYear - 1} has no posted revenue or expenses to start from`);
      }
      const b = await tx.budget.create({
        data: {
          orgId,
          fiscalYear: input.fiscalYear,
          version,
          name: input.name,
          note: input.note ?? null,
          basis: input.basis,
          sourceBudgetId: input.basis === 'COPY' ? input.sourceBudgetId : null,
          changePercent: input.basis === 'PRIOR_ACTUALS' ? new Prisma.Decimal(input.changePercent) : null,
          createdById: actor.id,
        },
      });
      await this.writeLines(tx, orgId, b.id, lines);
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'budget.created',
        entityType: 'budget',
        entityId: b.id,
        data: { fiscalYear: b.fiscalYear, version, name: b.name, basis: b.basis, sourceBudgetId: b.sourceBudgetId, changePercent: input.basis === 'PRIOR_ACTUALS' ? input.changePercent : null, accounts: lines.length },
      });
      return b.id;
    });
    return this.get(orgId, id);
  }

  private async writeLines(tx: Tx, orgId: string, budgetId: string, lines: { accountId: string; amounts: string[] }[]) {
    const data = lines.flatMap((l) => l.amounts.map((a, i) => ({ orgId, budgetId, accountId: l.accountId, periodNo: i + 1, amount: new Prisma.Decimal(a) })));
    if (data.length) await tx.budgetLine.createMany({ data });
  }

  private async draft(tx: Tx, orgId: string, id: string) {
    await tx.$executeRaw`SELECT 1 FROM budgets WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const b = await this.load(orgId, id, tx);
    if (b.status !== 'DRAFT') throw new DomainError('BUDGET_NOT_DRAFT', `Version ${b.version} is ${b.status.toLowerCase()}; only drafts change. Start a new version from it instead.`, HttpStatus.CONFLICT);
    return b;
  }

  async rename(orgId: string, actor: Actor, id: string, input: { name: string; note?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const b = await this.draft(tx, orgId, id);
      await tx.budget.update({ where: { id }, data: { name: input.name, note: input.note === undefined ? b.note : input.note } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'budget.renamed', entityType: 'budget', entityId: id, data: { from: b.name, to: input.name } });
    });
    return this.get(orgId, id);
  }

  /**
   * Replace the amounts of the accounts given (twelve months each); `amounts: null` takes
   * an account out of the budget. Accounts not mentioned are left as they are.
   */
  async saveLines(orgId: string, actor: Actor, id: string, input: { lines: { accountId: string; amounts: string[] | null }[] }) {
    const o = await this.org(orgId);
    const scale = minorUnits(o.functionalCurrency);
    const issues: { field: string; message: string }[] = [];
    const ids = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await this.prisma.account.findMany({ where: { orgId, id: { in: ids } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const seen = new Set<string>();
    input.lines.forEach((l, i) => {
      const a = byId.get(l.accountId);
      if (seen.has(l.accountId)) issues.push({ field: `lines.${i}.accountId`, message: 'The same account is given twice' });
      else if (!a) issues.push({ field: `lines.${i}.accountId`, message: 'Account not found' });
      else if (l.amounts && (!['REVENUE', 'EXPENSE'].includes(a.type) || !a.isPostable)) issues.push({ field: `lines.${i}.accountId`, message: `${a.code} ${a.name}: budgets hold postable revenue and expense accounts only` });
      else if (l.amounts && !a.isActive) issues.push({ field: `lines.${i}.accountId`, message: `${a.code} ${a.name} is inactive` });
      seen.add(l.accountId);
      const issue = l.amounts ? budgetAmountsIssue(l.amounts, scale) : null;
      if (issue) issues.push({ field: `lines.${i}.amounts`, message: a ? `${a.code} ${a.name}, ${issue.charAt(0).toLowerCase()}${issue.slice(1)}` : issue });
    });
    if (issues.length) throw new DomainError('BUDGET_INVALID', issues.map((x) => x.message).join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    await this.prisma.$transaction(async (tx) => {
      await this.draft(tx, orgId, id);
      const ids = input.lines.map((l) => l.accountId);
      const before = await tx.budgetLine.aggregate({ where: { orgId, budgetId: id, accountId: { in: ids } }, _sum: { amount: true } });
      await tx.budgetLine.deleteMany({ where: { orgId, budgetId: id, accountId: { in: ids } } });
      const keep = input.lines.filter((l): l is { accountId: string; amounts: string[] } => !!l.amounts).map((l) => ({ accountId: l.accountId, amounts: l.amounts.map((a) => new D(a.trim()).toFixed(scale)) }));
      await this.writeLines(tx, orgId, id, keep);
      await tx.budget.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'budget.lines_saved',
        entityType: 'budget',
        entityId: id,
        data: {
          accounts: keep.length,
          removed: input.lines.length - keep.length,
          before: (before._sum.amount ?? new Prisma.Decimal(0)).toFixed(scale),
          after: sum(keep.flatMap((l) => l.amounts.map((a) => new D(a)))).toFixed(scale),
        },
      });
    });
    return this.get(orgId, id);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const b = await this.draft(tx, orgId, id);
      const used = await tx.budget.count({ where: { orgId, sourceBudgetId: id } });
      if (used) throw new DomainError('BUDGET_IN_USE', `Version ${b.version} was copied into another version, so it is kept`, HttpStatus.CONFLICT);
      await tx.budgetLine.deleteMany({ where: { orgId, budgetId: id } });
      await tx.budget.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'budget.deleted', entityType: 'budget', entityId: id, data: { fiscalYear: b.fiscalYear, version: b.version, name: b.name } });
    });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ approval

  private async move(orgId: string, actor: Actor, id: string, from: BudgetStatus, step: (tx: Tx, b: Budget) => Promise<{ action: string; data: Record<string, unknown> }>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM budgets WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
      const b = await this.load(orgId, id, tx);
      if (b.status !== from) throw new DomainError('BUDGET_STATUS', `Version ${b.version} is ${b.status.toLowerCase()}`, HttpStatus.CONFLICT);
      const { action, data } = await step(tx, b);
      await this.audit.append(tx, { orgId, actorId: actor.id, action, entityType: 'budget', entityId: id, data: { fiscalYear: b.fiscalYear, version: b.version, ...data } });
    });
    return this.get(orgId, id);
  }

  submit(orgId: string, actor: Actor, id: string) {
    return this.move(orgId, actor, id, 'DRAFT', async (tx, b) => {
      const lines = await tx.budgetLine.count({ where: { orgId, budgetId: b.id } });
      if (!lines) throw new DomainError('BUDGET_EMPTY', 'Add amounts for at least one account before submitting');
      await tx.budget.update({ where: { id: b.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), submittedById: actor.id } });
      return { action: 'budget.submitted', data: {} };
    });
  }

  /** The submitter (or anyone who manages budgets) takes it back to draft. */
  withdraw(orgId: string, actor: Actor, id: string) {
    return this.move(orgId, actor, id, 'SUBMITTED', async (tx, b) => {
      await tx.budget.update({ where: { id: b.id }, data: { status: 'DRAFT', submittedAt: null, submittedById: null } });
      return { action: 'budget.withdrawn', data: {} };
    });
  }

  /** An approver sends it back with a reason. */
  sendBack(orgId: string, actor: Actor, id: string, reason: string) {
    return this.move(orgId, actor, id, 'SUBMITTED', async (tx, b) => {
      if (b.submittedById === actor.id) throw new DomainError('SELF_APPROVAL', 'You submitted this budget; withdraw it instead', HttpStatus.FORBIDDEN);
      await tx.budget.update({ where: { id: b.id }, data: { status: 'DRAFT', submittedAt: null, submittedById: null, returnedAt: new Date(), returnedById: actor.id, returnReason: reason } });
      return { action: 'budget.returned', data: { reason } };
    });
  }

  /** Approves the version; the year's earlier approved version, if any, is superseded. */
  approve(orgId: string, actor: Actor, id: string) {
    return this.move(orgId, actor, id, 'SUBMITTED', async (tx, b) => {
      if (b.submittedById === actor.id) throw new DomainError('SELF_APPROVAL', 'Someone other than the person who submitted it must approve a budget', HttpStatus.FORBIDDEN);
      const now = new Date();
      const previous = await tx.budget.findFirst({ where: { orgId, fiscalYear: b.fiscalYear, status: 'APPROVED' } });
      if (previous) await tx.budget.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', supersededAt: now } });
      await tx.budget.update({ where: { id: b.id }, data: { status: 'APPROVED', approvedAt: now, approvedById: actor.id } });
      return { action: 'budget.approved', data: { superseded: previous ? { id: previous.id, version: previous.version } : null } };
    });
  }

  // ------------------------------------------------------------------ variance

  /**
   * Budget against posted actuals up to `asOf`, by month, quarter or year. Months that have
   * not started have no actual; the month containing `asOf` counts actuals so far against its
   * whole budget.
   */
  async variance(orgId: string, id: string, q: { granularity: BudgetGranularity; asOf?: string }) {
    const o = await this.org(orgId);
    const scale = minorUnits(o.functionalCurrency);
    const b = await this.load(orgId, id);
    const periods = this.periods(b.fiscalYear, o.fiscalYearStartMonth);
    const asOf = q.asOf ?? todayIso();
    const started = periods.filter((p) => p.startDate <= asOf).length;
    const to = asOf < periods[11].endDate ? asOf : periods[11].endDate;
    const [lines, accounts, actual, who] = await Promise.all([
      this.prisma.budgetLine.findMany({ where: { orgId, budgetId: id } }),
      this.prisma.account.findMany({ where: { orgId, type: { in: ['REVENUE', 'EXPENSE'] } } }),
      started ? this.actuals(orgId, periods[0].startDate, to) : Promise.resolve(new Map<string, Map<string, Dec>>()),
      this.names([b.createdById, b.submittedById, b.approvedById, b.returnedById]),
    ]);
    const budgetBy = new Map<string, Dec[]>();
    for (const l of lines) {
      if (!budgetBy.has(l.accountId)) budgetBy.set(l.accountId, Array.from({ length: BUDGET_PERIODS }, () => new D(0)));
      budgetBy.get(l.accountId)![l.periodNo - 1] = new D(l.amount.toFixed());
    }
    const report = buildBudgetVariance({
      granularity: q.granularity,
      periodsStarted: started,
      scale,
      accounts: accounts.map((a) => ({
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type as BudgetAccountType,
        budget: budgetBy.get(a.id) ?? null,
        actual: periods.map((p) => actual.get(a.id)?.get(p.startDate.slice(0, 7)) ?? new D(0)),
      })),
    });
    const label = (ps: number[]) => (ps.length === 1 ? periods[ps[0] - 1].label : `${periods[ps[0] - 1].label} – ${periods[ps[ps.length - 1] - 1].label}`);
    return {
      currency: o.functionalCurrency,
      budget: this.header(b, who),
      asOf,
      actualsThrough: started ? to : null,
      granularity: q.granularity,
      periodsStarted: started,
      buckets: report.buckets.map((x, i) => ({
        key: q.granularity === 'QUARTER' ? `Q${i + 1}` : q.granularity === 'YEAR' ? `FY${b.fiscalYear}` : periods[x.periods[0] - 1].startDate.slice(0, 7),
        label: q.granularity === 'QUARTER' ? `Q${i + 1} (${label(x.periods)})` : q.granularity === 'YEAR' ? `FY${b.fiscalYear}` : label(x.periods),
        from: periods[x.periods[0] - 1].startDate,
        to: periods[x.periods[x.periods.length - 1] - 1].endDate,
        started: x.started,
        inProgress: x.started && periods[x.periods[x.periods.length - 1] - 1].endDate > asOf,
      })),
      rows: report.rows,
      revenue: report.revenue,
      expenses: report.expenses,
      netIncome: report.netIncome,
    };
  }
}
