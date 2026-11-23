import { HttpStatus, Injectable } from '@nestjs/common';
import { D, departmentPerformance, fiscalYearForDate, type PerformanceAmount, type PerformanceBudget } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { departmentBudgets } from '../db/collections/department-budgets';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { fiscalYearDates } from '../department-budgets/department-budgets.service';

const MAX_MONTHS = 24; // not money
const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`; // not money
};
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); // not money

/**
 * Department performance (DASH-035): revenue, spending, profit and margin per department over a
 * range of months, month by month, ranked, with spending in the fiscal year of the last month
 * against each department's budget (EXP-014). From posted journal lines and the departments they
 * carry; closing entries left out. Read only; reports.read.
 */
@Injectable()
export class DepartmentPerformanceService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async report(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const from = q.from ?? shift(to, -5);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first month must not be after the last');
    const months: string[] = [];
    for (let m = from; m <= to; m = shift(m, 1)) {
      months.push(m);
      if (months.length > MAX_MONTHS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_MONTHS} months`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const [departments, chart] = await Promise.all([
      this.prisma.dimensionValue.findMany({ where: { orgId: org.id, type: 'DEPARTMENT' }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, isActive: true } }),
      this.prisma.account.findMany({ where: { orgId: org.id, type: { in: ['REVENUE', 'EXPENSE'] } }, select: { id: true, type: true } }),
    ]);
    const types = new Map(chart.map((a) => [a.id, a.type as 'REVENUE' | 'EXPENSE']));
    const sums = chart.length
      ? await lineSums(this.store, org.id, {
          entry: postedBetween(toDbDate(`${from}-01`), toDbDate(lastDay(to)), { excludeClosing: true }),
          line: { accountId: { $in: [...types.keys()] } },
          by: { month: { $dateToString: { date: '$date', format: '%Y-%m' } }, accountId: 'lines.accountId', departmentId: 'lines.departmentId' },
        })
      : [];
    const amounts: PerformanceAmount[] = [];
    for (const s of sums) {
      const type = types.get(s.key.accountId as string);
      if (!type) continue;
      const v = type === 'REVENUE' ? s.credit.minus(s.debit) : s.debit.minus(s.credit);
      if (!v.isZero()) amounts.push({ departmentId: (s.key.departmentId as string | null) ?? null, month: s.key.month as string, type, amount: v.toFixed() });
    }
    // Budgets are for the fiscal year of the last month; spending is that year's, up to the end of the range.
    const fiscalYear = fiscalYearForDate(`${to}-01`, org.fiscalYearStartMonth);
    const fy = fiscalYearDates(fiscalYear, org.fiscalYearStartMonth);
    const budgetDocs = await runInOrg(org.id, () => this.store.collection(departmentBudgets).find({ fiscalYear }));
    const budgets: PerformanceBudget[] = [];
    if (budgetDocs.length) {
      const expenseIds = chart.filter((a) => a.type === 'EXPENSE').map((a) => a.id);
      const spent = await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(fy.start), toDbDate(lastDay(to)), { excludeClosing: true }), line: { accountId: { $in: expenseIds }, departmentId: { $type: 'string' } }, by: { departmentId: 'lines.departmentId' } });
      const byDept = new Map(spent.map((s) => [s.key.departmentId as string, s.debit.minus(s.credit)]));
      for (const b of budgetDocs) budgets.push({ departmentId: b.departmentId, amount: new D(String(b.amount)).toFixed(), spentInYear: (byDept.get(b.departmentId) ?? new D(0)).toFixed() });
    }
    const report = departmentPerformance(departments.map((d) => ({ id: d.id, code: d.code, name: d.name })), amounts, months, budgets);
    return { from, to, fromDate: `${from}-01`, toDate: lastDay(to), currency: org.functionalCurrency, fiscalYear, fiscalYearStart: fy.start, hasDepartments: departments.length > 0, ...report };
  }
}
