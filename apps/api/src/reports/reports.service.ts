import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountMovement,
  AccountType,
  buildAccountLedger,
  buildVendorSpend,
  previousPeriod,
  type SpendDocument,
  buildBalanceSheet,
  buildIncomeStatement,
  buildStatutoryStatements,
  buildTrialBalance,
  cashBasisMovements,
  type CashLine,
  type CashSettlement,
  D,
  defaultStatutoryFormat,
  STATUTORY_FORMATS,
  type StatutoryFormatId,
  type StatutoryStatement,
  Dec,
  minorUnits,
} from '@talk2tax/accounting-engine';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { runInOrg } from '../common/tenant-context';
import { journalEntries } from '../db/collections/ledger';
import { allocations, documents, payments } from '../db/collections/sales';
import { expenseClaims } from '../db/collections/expenses';
import { GraphService } from '../graph/graph.service';

/** All reports read only POSTED entries; drafts never affect balances. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly store: DocumentStoreService,
  ) {}

  /**
   * Movements by account. `profitAndLoss` leaves out closing entries (year-end closes to retained earnings), which
   * are not part of any period's profit; balances to a date keep them.
   */
  private async movements(orgId: string, from: string | null, to: string, dims: { departmentId?: string | null; projectId?: string | null } = {}, profitAndLoss = false): Promise<AccountMovement[]> {
    const fromDate = from ? toDbDate(from) : null;
    const dept = dims.departmentId ?? null;
    const project = dims.projectId ?? null;
    const sums = await lineSums(this.store, orgId, {
      entry: postedBetween(fromDate, toDbDate(to), { excludeClosing: profitAndLoss }),
      line: { ...(dept ? { departmentId: dept } : {}), ...(project ? { projectId: project } : {}) },
      by: { accountId: 'lines.accountId' },
    });
    const byAccount = new Map(sums.map((x) => [x.key.accountId as string, x]));
    const accounts = await this.prisma.account.findMany({ where: { orgId }, select: { id: true, code: true, name: true, type: true, subtype: true } });
    const rows = accounts.map((a) => ({ ...a, debit: byAccount.get(a.id)?.debit ?? new D(0), credit: byAccount.get(a.id)?.credit ?? new D(0) }));
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      debit: r.debit,
      credit: r.credit,
    }));
  }

  private async currency(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    return org.functionalCurrency;
  }

  async trialBalance(orgId: string, q: { from?: string; asOf: string; includeZero?: boolean }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const tb = buildTrialBalance(await this.movements(orgId, q.from ?? null, q.asOf), { includeZero: q.includeZero });
    return {
      currency: ccy,
      from: q.from ?? null,
      asOf: q.asOf,
      balanced: tb.balanced,
      totals: { debit: f(tb.totalDebit), credit: f(tb.totalCredit), netDebit: f(tb.totalNetDebit), netCredit: f(tb.totalNetCredit) },
      rows: tb.rows.map((r) => ({
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        type: r.type,
        subtype: r.subtype,
        debit: f(r.debit),
        credit: f(r.credit),
        netDebit: f(r.netDebit),
        netCredit: f(r.netCredit),
        balance: f(r.balance),
      })),
    };
  }

  async incomeStatement(orgId: string, q: { from: string; to: string; departmentId?: string; projectId?: string; basis?: 'ACCRUAL' | 'CASH' }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const accrual = buildIncomeStatement(await this.movements(orgId, q.from, q.to, q, true));
    const cash = q.basis === 'CASH' ? buildIncomeStatement(await this.cashMovements(orgId, q.from, q.to, q)) : null;
    const is = cash ?? accrual;
    const line = (l: { accountId: string; code: string; name: string; subtype?: string | null; amount: Dec }) => ({ ...l, subtype: l.subtype ?? null, amount: f(l.amount) });
    return {
      currency: ccy,
      from: q.from,
      to: q.to,
      basis: cash ? 'CASH' : 'ACCRUAL',
      revenue: is.revenue.map(line),
      expenses: is.expenses.map(line),
      totalRevenue: f(is.totalRevenue),
      totalExpenses: f(is.totalExpenses),
      netIncome: f(is.netIncome),
      /** Cash basis only: the accrual result for the same period, and what the cash view leaves out or moves to another period. */
      accrualNetIncome: cash ? f(accrual.netIncome) : null,
      notInCash: cash ? f(accrual.netIncome.minus(cash.netIncome)) : null,
    };
  }

  /**
   * Income and expense movements on a cash basis (GL-014): entries that move a bank or cash
   * account count in full on their date; invoices, bills, credit notes, expense claims and pay
   * runs count in the share paid or applied in the period (see cashBasisMovements). Closing
   * entries are left out, as on the accrual report.
   */
  private async cashMovements(orgId: string, from: string, to: string, dims: { departmentId?: string | null; projectId?: string | null }): Promise<AccountMovement[]> {
    const [fromDate, toDate] = [toDbDate(from), toDbDate(to)];
    const accs = await this.prisma.account.findMany({ where: { orgId }, select: { id: true, code: true, name: true, type: true, subtype: true } });
    const accounts = accs.map((a) => ({ accountId: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }));
    const cashIds = accs.filter((a) => a.subtype === 'BANK' || a.subtype === 'CASH').map((a) => a.id);
    const plIds = accs.filter((a) => a.type === 'REVENUE' || a.type === 'EXPENSE').map((a) => a.id);
    const dimFilter = { ...(dims.departmentId ? { departmentId: dims.departmentId } : {}), ...(dims.projectId ? { projectId: dims.projectId } : {}) };
    const inDims = (l: { departmentId: string | null; projectId: string | null }) => (!dims.departmentId || l.departmentId === dims.departmentId) && (!dims.projectId || l.projectId === dims.projectId);

    return runInOrg(orgId, async () => {
      // Money in or out with no invoice or bill behind it.
      const direct: CashLine[] = cashIds.length
        ? (
            await lineSums(this.store, orgId, {
              entry: { ...postedBetween(fromDate, toDate, { excludeClosing: true }), 'lines.accountId': { $in: cashIds } },
              line: { accountId: { $in: plIds }, ...dimFilter },
              by: { accountId: 'lines.accountId' },
            })
          ).map((x) => ({ accountId: x.key.accountId as string, debit: x.debit, credit: x.credit }))
        : [];

      // What was paid or applied in the period, by the accrual entry it settles: [entry id, settled, total].
      const shares: [string, string, string][] = [];
      const paid = await this.store.collection(payments).find({ status: 'POSTED', date: { $gte: fromDate, $lte: toDate } });
      const byPayment = paid.length ? await this.store.collection(allocations).find({ paymentId: { $in: paid.map((p) => p.id) }, removedOn: null }) : [];
      const byCredit = await this.store.collection(allocations).find({ creditDocumentId: { $ne: null }, removedOn: null, date: { $gte: fromDate, $lte: toDate } });
      const docIds = [...new Set([...byPayment, ...byCredit].flatMap((a) => [a.targetId, a.creditDocumentId]).filter((x): x is string => !!x))];
      const docs = new Map((docIds.length ? await this.store.collection(documents).find({ id: { $in: docIds }, status: 'POSTED' }) : []).map((d) => [d.id, d]));
      const settle = (docId: string | null, amount: string) => {
        const d = docId ? docs.get(docId) : undefined;
        if (d?.journalEntryId) shares.push([d.journalEntryId, amount, d.total]);
      };
      for (const a of byPayment) settle(a.targetId, a.amount);
      // A credit note applied to an invoice settles both: the invoice's income and the credit note's reversal of it.
      for (const a of byCredit) {
        settle(a.targetId, a.amount);
        settle(a.creditDocumentId, a.amount);
      }
      // Expense claims count when the employee is paid back.
      const claims = await this.store.collection(expenseClaims).find({ status: 'REIMBURSED', reimbursedOn: { $gte: fromDate, $lte: toDate } });
      for (const c of claims) if (c.journalEntryId) shares.push([c.journalEntryId, c.total, c.total]);
      // Pay runs count as their salaries and statutory dues are paid.
      const remitted = await this.prisma.payrollRemittance.findMany({ where: { orgId, status: 'POSTED', date: { gte: fromDate, lte: toDate } }, select: { amount: true, payRun: { select: { journalEntryId: true } } } });

      const entryIds = [...new Set([...shares.map((x) => x[0]), ...remitted.map((r) => r.payRun.journalEntryId).filter((x): x is string => !!x)])];
      const entries = new Map((entryIds.length ? await this.store.collection(journalEntries).find({ id: { $in: entryIds }, status: 'POSTED' }) : []).map((e) => [e.id, e]));
      const linesOf = (id: string) => (entries.get(id)?.lines ?? []).filter(inDims).map((l) => ({ accountId: l.accountId, debit: l.functionalDebit, credit: l.functionalCredit }));
      const settlements: CashSettlement[] = shares.filter(([id]) => entries.has(id)).map(([id, settled, total]) => ({ lines: linesOf(id), settled, total }));
      for (const r of remitted) {
        const e = r.payRun.journalEntryId ? entries.get(r.payRun.journalEntryId) : undefined;
        if (e) settlements.push({ lines: linesOf(e.id), settled: r.amount.toFixed(), total: e.totalCredit });
      }
      return cashBasisMovements(accounts, direct, settlements);
    });
  }

  async balanceSheet(orgId: string, q: { asOf: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const bs = buildBalanceSheet(await this.movements(orgId, null, q.asOf));
    const line = (l: { accountId: string; code: string; name: string; subtype?: string | null; amount: Dec }) => ({ ...l, subtype: l.subtype ?? null, amount: f(l.amount) });
    return {
      currency: ccy,
      asOf: q.asOf,
      balanced: bs.balanced,
      assets: bs.assets.map(line),
      liabilities: bs.liabilities.map(line),
      equity: bs.equity.map(line),
      unclosedEarnings: f(bs.unclosedEarnings),
      totalAssets: f(bs.totalAssets),
      totalLiabilities: f(bs.totalLiabilities),
      totalEquity: f(bs.totalEquity),
    };
  }

  /**
   * Vendor spending (RPT-016): posted bills before tax less vendor credits, by vendor, account
   * and month, against the same number of days just before. Functional currency.
   */
  async vendorSpend(orgId: string, q: { from: string; to: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const accounts = new Map((await this.prisma.account.findMany({ where: { orgId }, select: { id: true, code: true, name: true } })).map((a) => [a.id, a]));
    const before = previousPeriod(q.from, q.to);
    const load = async (from: string, to: string): Promise<SpendDocument[]> => {
      const docs = await this.prisma.document.findMany({
        where: { orgId, kind: { in: ['BILL', 'VENDOR_CREDIT'] }, status: 'POSTED', issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
        select: { contactId: true, kind: true, issueDate: true, exchangeRate: true, lines: { select: { accountId: true, netAmount: true } } },
      });
      return docs.map((d) => ({
        vendorId: d.contactId,
        vendorName: '',
        kind: d.kind as SpendDocument['kind'],
        issueDate: fromDbDate(d.issueDate),
        exchangeRate: d.exchangeRate.toString(),
        lines: d.lines.map((l) => ({ accountId: l.accountId, accountCode: accounts.get(l.accountId)?.code ?? '', accountName: accounts.get(l.accountId)?.name ?? '', netAmount: l.netAmount.toString() })),
      }));
    };
    const [current, previous] = await Promise.all([load(q.from, q.to), load(before.from, before.to)]);
    const ids = [...new Set([...current, ...previous].map((d) => d.vendorId))];
    const names = new Map((ids.length ? await this.prisma.contact.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
    for (const d of [...current, ...previous]) d.vendorName = names.get(d.vendorId) ?? 'Unknown vendor';
    const s = buildVendorSpend(current, previous, ccy);
    const pct = (x: Dec | null) => (x === null ? null : x.toFixed(4));
    return {
      currency: ccy,
      from: q.from,
      to: q.to,
      previous: before,
      total: f(s.total),
      previousTotal: f(s.previousTotal),
      change: f(s.change),
      vendorsFor80Percent: s.vendorsFor80Percent,
      vendors: s.vendors.map((v) => ({ id: v.id, name: v.name, amount: f(v.amount), share: pct(v.share), bills: v.bills, previous: f(v.previous), change: f(v.change) })),
      accounts: s.accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, amount: f(a.amount), share: pct(a.share) })),
      months: s.months.map((m) => ({ month: m.month, amount: f(m.amount) })),
    };
  }

  async statutoryFormats(orgId: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
    return {
      default: defaultStatutoryFormat(org.countryCode),
      formats: STATUTORY_FORMATS.map((f) => ({ id: f.id, name: f.name, countries: f.countries, basis: f.basis })),
    };
  }

  async statutory(orgId: string, q: { from: string; to: string; format?: StatutoryFormatId; comparative: boolean }) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, legalName: true, countryCode: true, functionalCurrency: true } });
    const ccy = org.functionalCurrency;
    const f = (d: Dec | null) => (d === null ? null : d.toFixed(minorUnits(ccy)));
    const formatId = q.format ?? defaultStatutoryFormat(org.countryCode);
    const run = async (from: string, to: string) => buildStatutoryStatements(formatId, await this.movements(orgId, null, to), await this.movements(orgId, from, to, {}, true));
    const now = await run(q.from, q.to);
    const prevRange = { from: yearBefore(q.from), to: yearBefore(q.to) };
    const prev = q.comparative ? await run(prevRange.from, prevRange.to) : null;
    const merge = (cur: StatutoryStatement, before: StatutoryStatement | null) =>
      cur.rows.map((r) => {
        const p = before?.rows.find((x) => x.key === r.key);
        return { key: r.key, label: r.label, kind: r.kind, level: r.level, note: r.note, amount: f(r.amount), previous: p ? f(p.amount) : null, accounts: r.accounts.map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, amount: f(a.amount) })) };
      });
    const fm = now.format;
    return {
      organisation: { name: org.name, legalName: org.legalName, countryCode: org.countryCode },
      currency: ccy,
      format: { id: fm.id, name: fm.name, basis: fm.basis, balanceSheetTitle: fm.balanceSheetTitle, profitAndLossTitle: fm.profitAndLossTitle, sources: fm.sources, notIncluded: fm.notIncluded, isCountryDefault: formatId === defaultStatutoryFormat(org.countryCode) },
      from: q.from,
      to: q.to,
      previous: prev ? prevRange : null,
      balanceSheet: merge(now.balanceSheet, prev?.balanceSheet ?? null),
      profitAndLoss: merge(now.profitAndLoss, prev?.profitAndLoss ?? null),
      checks: { balanced: now.balanced && (prev?.balanced ?? true), profitAgrees: now.profitAgrees && (prev?.profitAgrees ?? true), netProfit: f(now.netProfit) },
      unclassified: now.unclassified,
    };
  }

  async accountLedger(orgId: string, q: { accountId: string; from: string; to: string }) {
    const account = await this.prisma.account.findFirst({ where: { id: q.accountId, orgId } });
    if (!account) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const opening = await this.prisma.journalLine.aggregate({
      where: { orgId, accountId: q.accountId, entry: { status: 'POSTED', date: { lt: toDbDate(q.from) } } },
      _sum: { functionalDebit: true, functionalCredit: true },
    });
    const od = new D(opening._sum.functionalDebit?.toFixed() ?? '0');
    const oc = new D(opening._sum.functionalCredit?.toFixed() ?? '0');
    const sign = account.type === 'ASSET' || account.type === 'EXPENSE' ? 1 : -1;
    const openingBalance = od.minus(oc).times(sign);
    const lines = await this.prisma.journalLine.findMany({
      where: { orgId, accountId: q.accountId, entry: { status: 'POSTED', date: { gte: toDbDate(q.from), lte: toDbDate(q.to) } } },
      include: { entry: { select: { id: true, date: true, entryNumber: true, memo: true } } },
    });
    const sources = await this.graph.entrySources(orgId, [...new Set(lines.map((l) => l.entry.id))]);
    const rows = buildAccountLedger(
      account.type,
      openingBalance,
      lines.map((l) => ({
        date: fromDbDate(l.entry.date),
        entryNumber: l.entry.entryNumber ?? 0,
        journalId: l.entry.id,
        memo: l.entry.memo,
        description: l.description,
        debit: l.functionalDebit.toFixed(),
        credit: l.functionalCredit.toFixed(),
      })),
    );
    return {
      currency: ccy,
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      from: q.from,
      to: q.to,
      openingBalance: f(openingBalance),
      closingBalance: f(rows.length ? rows[rows.length - 1].runningBalance : openingBalance),
      // Each line says which record created its entry, so a figure can be traced to its source document.
      rows: rows.map((r) => ({ ...r, debit: f(r.debit), credit: f(r.credit), runningBalance: f(r.runningBalance), source: sources.get(r.journalId) ?? null })),
    };
  }

  /**
   * Owner dashboard figures for the fiscal year containing `asOf`, all derived from posted entries:
   * cash, receivables and payables balances (by account subtype), year-to-date P&L, and a
   * per-period series of revenue, expenses, net income and closing cash.
   */
  async dashboard(orgId: string, q: { asOf: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const asOf = toDbDate(q.asOf);
    const period = await this.prisma.fiscalPeriod.findFirst({ where: { orgId, startDate: { lte: asOf }, endDate: { gte: asOf } } });
    if (!period) throw new NotFoundException({ error: 'NO_FISCAL_PERIOD', message: `No fiscal period covers ${q.asOf}` });
    const periods = await this.prisma.fiscalPeriod.findMany({ where: { orgId, fiscalYear: period.fiscalYear }, orderBy: { periodNo: 'asc' } });

    const sums = await lineSums(this.store, orgId, { entry: postedBetween(null, asOf, { excludeClosing: true }), by: { periodId: 'periodId', date: 'date', accountId: 'lines.accountId' } });
    const kinds = new Map((await this.prisma.account.findMany({ where: { orgId }, select: { id: true, type: true, subtype: true } })).map((a) => [a.id, a]));
    const bucketOf = (a: { type: string; subtype: string | null } | undefined) =>
      !a ? 'OTHER' : a.type === 'REVENUE' ? 'REVENUE' : a.type === 'EXPENSE' ? 'EXPENSE' : a.subtype === 'CASH' || a.subtype === 'BANK' ? 'CASH' : a.subtype === 'ACCOUNTS_RECEIVABLE' ? 'AR' : a.subtype === 'ACCOUNTS_PAYABLE' ? 'AP' : 'OTHER';
    const rows = sums.map((x) => ({
      period_id: (x.key.date as Date) >= periods[0].startDate ? (x.key.periodId as string) : null,
      bucket: bucketOf(kinds.get(x.key.accountId as string)),
      debit: x.debit,
      credit: x.credit,
    }));

    const zero = () => new D(0);
    const net = (r: { debit: Dec; credit: Dec }) => r.debit.minus(r.credit);
    let cash = zero(), ar = zero(), ap = zero();
    let openingCash = zero();
    const perPeriod = new Map<string, { revenue: Dec; expenses: Dec; cash: Dec }>();
    for (const p of periods) perPeriod.set(p.id, { revenue: zero(), expenses: zero(), cash: zero() });
    for (const r of rows) {
      const n = net(r);
      if (r.bucket === 'CASH') {
        cash = cash.plus(n);
        if (r.period_id && perPeriod.has(r.period_id)) perPeriod.get(r.period_id)!.cash = perPeriod.get(r.period_id)!.cash.plus(n);
        else openingCash = openingCash.plus(n);
      }
      if (r.bucket === 'AR') ar = ar.plus(n);
      if (r.bucket === 'AP') ap = ap.minus(n);
      if (r.period_id && perPeriod.has(r.period_id)) {
        const b = perPeriod.get(r.period_id)!;
        if (r.bucket === 'REVENUE') b.revenue = b.revenue.minus(n);
        if (r.bucket === 'EXPENSE') b.expenses = b.expenses.plus(n);
      }
    }
    let running = openingCash;
    let ytdRevenue = zero(), ytdExpenses = zero();
    const months = periods
      .filter((p) => p.startDate <= asOf)
      .map((p) => {
        const b = perPeriod.get(p.id)!;
        running = running.plus(b.cash);
        ytdRevenue = ytdRevenue.plus(b.revenue);
        ytdExpenses = ytdExpenses.plus(b.expenses);
        return {
          periodId: p.id,
          name: p.name,
          startDate: fromDbDate(p.startDate),
          endDate: fromDbDate(p.endDate),
          status: p.status,
          revenue: f(b.revenue),
          expenses: f(b.expenses),
          netIncome: f(b.revenue.minus(b.expenses)),
          closingCash: f(running),
        };
      });
    const draftCount = await this.prisma.journalEntry.count({ where: { orgId, status: 'DRAFT' } });
    return {
      currency: ccy,
      asOf: q.asOf,
      fiscalYear: period.fiscalYear,
      fiscalYearStart: fromDbDate(periods[0].startDate),
      balances: { cash: f(cash), receivables: f(ar), payables: f(ap) },
      yearToDate: { revenue: f(ytdRevenue), expenses: f(ytdExpenses), netIncome: f(ytdRevenue.minus(ytdExpenses)) },
      periods: months,
      draftJournals: draftCount,
    };
  }
}

/** The same day a year earlier (29 February becomes 28 February). */
function yearBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
