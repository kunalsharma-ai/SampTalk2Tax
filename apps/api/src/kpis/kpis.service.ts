import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountType,
  addPl,
  computeKpis,
  concentration,
  D,
  Dec,
  fiscalYearForDate,
  KPI_DEFINITIONS,
  kpiChange,
  KpiKey,
  kpiSeries,
  minorUnits,
  MonthFigures,
  monthFigures,
  PL_LINES,
  PlFigures,
  plFigures,
  plFromAmounts,
  SubtypeTotals,
  targetStatus,
  zeroPl,
} from '@talk2tax/accounting-engine';
import { KpiComparator, Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { todayIst } from '../cash-flow/cash-flow.service';

type Actor = { id: string };
/** Months of history fetched for the KPI page: 13 shown (this month and the same month last year) plus 2 for trailing windows. */
const KPI_MONTHS = 15;

/** YYYY-MM of an ISO date. */
const monthOf = (iso: string) => iso.slice(0, 7);
export function shiftMonth(month: string, by: number): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7) - 1 + by;
  const yy = y + Math.floor(m / 12);
  return `${yy}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}
export function monthEnd(month: string): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

export const KPI_KEYS = KPI_DEFINITIONS.map((d) => d.key) as [KpiKey, ...KpiKey[]];

@Injectable()
export class KpisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  private async org(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true, fiscalYearStartMonth: true } });
    return { currency: o.functionalCurrency, scale: minorUnits(o.functionalCurrency), startMonth: o.fiscalYearStartMonth };
  }

  /** The month asked for, or the last complete month; never a month after today. */
  private resolveMonth(month: string | undefined) {
    const today = todayIst();
    const m = month ?? shiftMonth(monthOf(today), -1);
    if (m > monthOf(today)) throw new DomainError('INVALID_MONTH', 'That month has not started yet');
    if (m < '2000-01') throw new DomainError('INVALID_MONTH', 'Months start from 2000');
    const end = monthEnd(m);
    return { month: m, from: `${m}-01`, to: end < today ? end : today, inProgress: end >= today, today };
  }

  /**
   * Posted-journal figures for `count` calendar months ending with `last` (whose end is
   * capped at `lastTo`): movements by type and subtype per month, and asset and liability
   * balances at each month end.
   */
  async monthFigures(orgId: string, last: string, lastTo: string, count: number): Promise<MonthFigures[]> {
    const first = shiftMonth(last, -(count - 1));
    const firstDay = toDbDate(`${first}-01`);
    const accounts = new Map((await this.prisma.account.findMany({ where: { orgId }, select: { id: true, type: true, subtype: true } })).map((a) => [a.id, a]));
    const sums = await lineSums(this.store, orgId, {
      entry: postedBetween(null, toDbDate(lastTo), { excludeClosing: true }),
      by: { month: { $cond: [{ $gte: ['$date', firstDay] }, { $dateToString: { date: '$date', format: '%Y-%m' } }, null] }, accountId: 'lines.accountId' },
    });
    const grouped = new Map<string, { month: string | null; type: AccountType; subtype: string | null; debit: Dec; credit: Dec }>();
    for (const r of sums) {
      const a = accounts.get(r.key.accountId as string);
      const month = (r.key.month as string | null) ?? null;
      if (!a || (month === null && a.type !== 'ASSET' && a.type !== 'LIABILITY')) continue;
      const k = `${month}|${a.type}|${a.subtype ?? ''}`;
      const cur = grouped.get(k) ?? { month, type: a.type as AccountType, subtype: a.subtype as string | null, debit: new D(0), credit: new D(0) };
      grouped.set(k, { ...cur, debit: cur.debit.plus(r.debit), credit: cur.credit.plus(r.credit) });
    }
    const rows = [...grouped.values()];
    const key = (r: { type: string; subtype: string | null }) => `${r.type}|${r.subtype ?? ''}`;
    const running = new Map<string, SubtypeTotals>();
    const add = (r: (typeof rows)[number]) => {
      const k = key(r);
      const cur = running.get(k) ?? { type: r.type, subtype: r.subtype, debit: new D(0), credit: new D(0) };
      running.set(k, { ...cur, debit: (cur.debit as Dec).plus(r.debit.toFixed()), credit: (cur.credit as Dec).plus(r.credit.toFixed()) });
    };
    for (const r of rows) if (r.month === null) add(r);
    const out: MonthFigures[] = [];
    for (let i = 0; i < count; i++) {
      const month = shiftMonth(first, i);
      const these = rows.filter((r) => r.month === month);
      for (const r of these) if (r.type === 'ASSET' || r.type === 'LIABILITY') add(r);
      const movements = these.map((r) => ({ type: r.type, subtype: r.subtype, debit: r.debit.toFixed(), credit: r.credit.toFixed() }));
      const cashChange = these.filter((r) => r.type === 'ASSET' && (r.subtype === 'CASH' || r.subtype === 'BANK')).reduce((a, r) => a.plus(r.debit.toFixed()).minus(r.credit.toFixed()), new D(0));
      const end = monthEnd(month);
      out.push(monthFigures({ month, from: `${month}-01`, to: end < lastTo ? end : lastTo }, movements, [...running.values()], cashChange.toFixed()));
    }
    return out;
  }

  /** Revenue by customer from posted invoices and credit notes (their revenue lines), in a date range. */
  async customerRevenue(orgId: string, from: string, to: string, scale: number, top = 5) {
    const revenueAccounts = await this.prisma.account.findMany({ where: { orgId, type: 'REVENUE', OR: [{ subtype: null }, { subtype: { not: 'OTHER_INCOME' } }] }, select: { id: true } });
    const sums = revenueAccounts.length
      ? await lineSums(this.store, orgId, { entry: postedBetween(toDbDate(from), toDbDate(to)), line: { accountId: { $in: revenueAccounts.map((a) => a.id) } }, by: { entryId: '_id' } })
      : [];
    const entryIds = sums.map((r) => r.key.entryId as string);
    const docs = entryIds.length
      ? await this.prisma.document.findMany({ where: { orgId, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, OR: [{ journalEntryId: { in: entryIds } }, { voidJournalEntryId: { in: entryIds } }] }, select: { contactId: true, journalEntryId: true, voidJournalEntryId: true } })
      : [];
    const perContact = new Map<string, Dec>();
    for (const r of sums) {
      const id = r.key.entryId as string;
      for (const d of docs) if (d.journalEntryId === id || d.voidJournalEntryId === id) perContact.set(d.contactId, (perContact.get(d.contactId) ?? new D(0)).plus(r.credit).minus(r.debit));
    }
    const names = new Map((perContact.size ? await this.prisma.contact.findMany({ where: { orgId, id: { in: [...perContact.keys()] } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
    const rows = [...perContact.entries()].map(([id, revenue]) => ({ id, name: names.get(id) ?? '', revenue }));
    return concentration(
      rows.map((r) => ({ id: r.id, name: r.name, revenue: r.revenue.toFixed() })),
      top,
      scale,
    );
  }

  // ------------------------------------------------------------------ KPIs

  async kpis(orgId: string, q: { month?: string }) {
    const o = await this.org(orgId);
    const m = this.resolveMonth(q.month);
    const months = await this.monthFigures(orgId, m.month, m.to, KPI_MONTHS);
    const series = kpiSeries(months, o.scale);
    const current = computeKpis(months, o.scale);
    const targets = new Map((await this.prisma.kpiTarget.findMany({ where: { orgId } })).map((t) => [t.kpi, t]));
    const shown = months.slice(-13).map((x) => x.month);
    const at = (k: KpiKey, month: string) => series[k].find((s) => s.month === month)?.value ?? null;
    const prev = shiftMonth(m.month, -1);
    const lastYear = shiftMonth(m.month, -12);
    const yearFrom = `${shiftMonth(m.month, -11)}-01`;
    return {
      currency: o.currency,
      month: m.month,
      from: m.from,
      to: m.to,
      inProgress: m.inProgress,
      previousMonth: prev,
      sameMonthLastYear: lastYear,
      kpis: current.map((k) => {
        const def = KPI_DEFINITIONS.find((d) => d.key === k.key)!;
        const t = targets.get(k.key);
        const previous = at(k.key, prev);
        return {
          ...def,
          ...k,
          previous,
          ...kpiChange(k.key, k.value, previous),
          lastYear: at(k.key, lastYear),
          target: t ? { comparator: t.comparator, target: t.target.toFixed(), note: t.note, status: targetStatus(k.value, t.comparator, t.target.toFixed()) } : null,
          series: series[k.key].filter((s) => shown.includes(s.month)),
        };
      }),
      customers: { from: yearFrom, to: m.to, ...(await this.customerRevenue(orgId, yearFrom, m.to, o.scale)) },
    };
  }

  async listTargets(orgId: string) {
    const rows = await this.prisma.kpiTarget.findMany({ where: { orgId }, orderBy: { kpi: 'asc' } });
    return rows.map((t) => ({ kpi: t.kpi, comparator: t.comparator, target: t.target.toFixed(), note: t.note, updatedAt: t.updatedAt.toISOString() }));
  }

  async setTarget(orgId: string, actor: Actor, kpi: KpiKey, input: { comparator: KpiComparator; target: string; note?: string | null }) {
    const def = KPI_DEFINITIONS.find((d) => d.key === kpi);
    if (!def) throw new DomainError('UNKNOWN_KPI', 'No such KPI', HttpStatus.NOT_FOUND);
    if (def.unit !== 'MONEY' && kpi !== 'netCashFlow' && new D(input.target).isNegative()) throw new DomainError('INVALID_TARGET', `${def.label} cannot be negative`);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.kpiTarget.findUnique({ where: { orgId_kpi: { orgId, kpi } } });
      const data = { comparator: input.comparator, target: new Prisma.Decimal(input.target), note: input.note ?? null, updatedById: actor.id };
      const row = await tx.kpiTarget.upsert({ where: { orgId_kpi: { orgId, kpi } }, create: { orgId, kpi, ...data }, update: data });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'kpi.target_set',
        entityType: 'kpi_target',
        entityId: row.id,
        data: { kpi, from: before ? { comparator: before.comparator, target: before.target.toFixed() } : null, to: { comparator: input.comparator, target: input.target } },
      });
    });
    return (await this.listTargets(orgId)).find((t) => t.kpi === kpi)!;
  }

  async removeTarget(orgId: string, actor: Actor, kpi: string) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.kpiTarget.findUnique({ where: { orgId_kpi: { orgId, kpi } } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No target for that KPI' });
      await tx.kpiTarget.delete({ where: { id: before.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'kpi.target_removed', entityType: 'kpi_target', entityId: before.id, data: { kpi, comparator: before.comparator, target: before.target.toFixed() } });
    });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ management report

  /** A budget's amounts summed by period and account type and subtype. */
  private async budgetTotals(orgId: string, budgetId: string) {
    const lines = await this.prisma.budgetLine.findMany({ where: { orgId, budgetId }, select: { periodNo: true, amount: true, account: { select: { type: true, subtype: true } } } });
    const out = new Map<string, { period_no: number; type: AccountType; subtype: string | null; amount: Prisma.Decimal }>();
    for (const l of lines) {
      const k = `${l.periodNo}|${l.account.type}|${l.account.subtype ?? ''}`;
      const cur = out.get(k);
      out.set(k, { period_no: l.periodNo, type: l.account.type as AccountType, subtype: l.account.subtype as string | null, amount: (cur?.amount ?? new Prisma.Decimal(0)).plus(l.amount) });
    }
    return [...out.values()];
  }

  private async budgetPl(orgId: string, startMonth: number, months: string[]) {
    const out = new Map<string, PlFigures>();
    const byYear = new Map<number, string[]>();
    for (const m of months) {
      const fy = fiscalYearForDate(`${m}-01`, startMonth);
      byYear.set(fy, [...(byYear.get(fy) ?? []), m]);
    }
    const versions: Record<number, { id: string; version: number; name: string } | null> = {};
    for (const [fy, ms] of byYear) {
      const b = await this.prisma.budget.findFirst({ where: { orgId, fiscalYear: fy, status: 'APPROVED' }, select: { id: true, version: true, name: true } });
      versions[fy] = b;
      if (!b) continue;
      const lines = await this.budgetTotals(orgId, b.id);
      const fyStart = `${startMonth === 1 ? fy : fy - 1}-${String(startMonth).padStart(2, '0')}`;
      for (const m of ms) {
        const periodNo = (+m.slice(0, 4) - +fyStart.slice(0, 4)) * 12 + (+m.slice(5, 7) - +fyStart.slice(5, 7)) + 1;
        out.set(m, plFromAmounts(lines.filter((l) => Number(l.period_no) === periodNo).map((l) => ({ type: l.type, subtype: l.subtype, amount: l.amount.toFixed() }))));
      }
    }
    return { pl: out, versions };
  }

  /** The figures of a month's management report, computed from the books now. */
  private async computeReport(orgId: string, month: string) {
    const o = await this.org(orgId);
    const m = this.resolveMonth(month);
    const fy = fiscalYearForDate(m.from, o.startMonth);
    const fyStartMonth = `${o.startMonth === 1 ? fy : fy - 1}-${String(o.startMonth).padStart(2, '0')}`;
    const monthsSoFar = (+month.slice(0, 4) - +fyStartMonth.slice(0, 4)) * 12 + (+month.slice(5, 7) - +fyStartMonth.slice(5, 7)) + 1;
    const count = Math.max(KPI_MONTHS, 13, monthsSoFar);
    const figures = await this.monthFigures(orgId, month, m.to, count);
    const byMonth = new Map(figures.map((f) => [f.month, f]));
    const ytdMonths = figures.slice(-monthsSoFar).map((f) => f.month);
    const budget = await this.budgetPl(orgId, o.startMonth, ytdMonths);
    const f = (x: Dec) => x.toFixed(o.scale);
    const pl = (mm: string) => (byMonth.has(mm) ? plFigures(byMonth.get(mm)!) : zeroPl());
    const actual = pl(month);
    const previous = pl(shiftMonth(month, -1));
    const lastYear = pl(shiftMonth(month, -12));
    const ytd = ytdMonths.map(pl).reduce(addPl, zeroPl());
    const hasBudget = !!budget.versions[fy];
    const monthBudget = budget.pl.get(month) ?? null;
    const ytdBudget = hasBudget ? ytdMonths.map((x) => budget.pl.get(x) ?? zeroPl()).reduce(addPl, zeroPl()) : null;
    const kpis = computeKpis(figures, o.scale);
    const series = kpiSeries(figures, o.scale);
    const cur = byMonth.get(month)!;
    return {
      currency: o.currency,
      month,
      from: m.from,
      to: m.to,
      inProgress: m.inProgress,
      fiscalYear: fy,
      ytdFrom: `${fyStartMonth}-01`,
      budget: budget.versions[fy] ? { id: budget.versions[fy]!.id, label: `v${budget.versions[fy]!.version} ${budget.versions[fy]!.name}` } : null,
      lines: PL_LINES.map((l) => {
        const a = actual[l.key];
        const b = monthBudget?.[l.key] ?? null;
        const better = (x: Dec, y: Dec) => (l.kind === 'EXPENSE' ? !x.greaterThan(y) : !x.lessThan(y));
        return {
          key: l.key,
          label: l.label,
          kind: l.kind,
          actual: f(a),
          previous: f(previous[l.key]),
          lastYear: f(lastYear[l.key]),
          budget: b ? f(b) : null,
          variance: b ? f(a.minus(b)) : null,
          favourable: b && !a.equals(b) ? better(a, b) : null,
          ytd: f(ytd[l.key]),
          ytdBudget: ytdBudget ? f(ytdBudget[l.key]) : null,
        };
      }),
      cash: { opening: f(cur.cash.minus(cur.cashChange)), change: f(cur.cashChange), closing: f(cur.cash) },
      kpis: kpis.map((k) => {
        const previousValue = series[k.key].find((s) => s.month === shiftMonth(month, -1))?.value ?? null;
        return { key: k.key, label: KPI_DEFINITIONS.find((d) => d.key === k.key)!.label, unit: KPI_DEFINITIONS.find((d) => d.key === k.key)!.unit, value: k.value, reason: k.reason, previous: previousValue, ...kpiChange(k.key, k.value, previousValue) };
      }),
      customers: await this.customerRevenue(orgId, m.from, m.to, o.scale),
    };
  }

  async listReports(orgId: string) {
    const rows = await this.prisma.managementReport.findMany({ where: { orgId }, orderBy: { month: 'desc' } });
    const today = todayIst();
    const latest = monthOf(today);
    const months = Array.from({ length: 24 }, (_, i) => shiftMonth(latest, -i));
    const byMonth = new Map(rows.map((r) => [monthOf(fromDbDate(r.month)), r]));
    const who = await this.names(rows.map((r) => r.finalisedById));
    return months.map((mm) => {
      const r = byMonth.get(mm);
      return {
        month: mm,
        ended: monthEnd(mm) < today,
        status: r?.status ?? null,
        hasCommentary: !!r?.commentary,
        finalisedBy: r?.finalisedById ? (who.get(r.finalisedById) ?? 'Former member') : null,
        finalisedAt: r?.finalisedAt?.toISOString() ?? null,
      };
    });
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }

  private checkMonth(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DomainError('INVALID_MONTH', 'A month as YYYY-MM');
  }

  async report(orgId: string, month: string) {
    this.checkMonth(month);
    const row = await this.prisma.managementReport.findUnique({ where: { orgId_month: { orgId, month: toDbDate(`${month}-01`) } } });
    const live = await this.computeReport(orgId, month);
    const who = await this.names([row?.updatedById ?? null, row?.finalisedById ?? null]);
    const meta = {
      status: row?.status ?? 'DRAFT',
      commentary: row?.commentary ?? '',
      updatedBy: row ? (who.get(row.updatedById) ?? 'Former member') : null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      finalisedBy: row?.finalisedById ? (who.get(row.finalisedById) ?? 'Former member') : null,
      finalisedAt: row?.finalisedAt?.toISOString() ?? null,
    };
    if (row?.status === 'FINAL') {
      const snap = row.snapshot as unknown as typeof live;
      // Postings after the report was finalised: lines whose month figure is now different.
      const changed = snap.lines.filter((l) => live.lines.find((x) => x.key === l.key)!.actual !== l.actual).map((l) => ({ key: l.key, label: l.label, then: l.actual, now: live.lines.find((x) => x.key === l.key)!.actual }));
      return { ...snap, ...meta, changedSince: changed };
    }
    return { ...live, ...meta, changedSince: [] };
  }

  async saveCommentary(orgId: string, actor: Actor, month: string, commentary: string) {
    this.checkMonth(month);
    this.resolveMonth(month);
    await this.prisma.$transaction(async (tx) => {
      const key = { orgId_month: { orgId, month: toDbDate(`${month}-01`) } };
      const before = await tx.managementReport.findUnique({ where: key });
      if (before?.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'This management report is final and cannot be changed', HttpStatus.CONFLICT);
      const row = await tx.managementReport.upsert({ where: key, create: { orgId, month: toDbDate(`${month}-01`), commentary, updatedById: actor.id }, update: { commentary, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'management_report.commentary_saved', entityType: 'management_report', entityId: row.id, data: { month, length: commentary.length } });
    });
    return this.report(orgId, month);
  }

  async finalise(orgId: string, actor: Actor, month: string) {
    this.checkMonth(month);
    const m = this.resolveMonth(month);
    if (m.inProgress) throw new DomainError('MONTH_NOT_ENDED', 'A month can be finalised once it has ended', HttpStatus.CONFLICT);
    const snapshot = await this.computeReport(orgId, month);
    await this.prisma.$transaction(async (tx) => {
      const key = { orgId_month: { orgId, month: toDbDate(`${month}-01`) } };
      const before = await tx.managementReport.findUnique({ where: key });
      if (before?.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'This management report is already final', HttpStatus.CONFLICT);
      const row = before ?? (await tx.managementReport.create({ data: { orgId, month: toDbDate(`${month}-01`), updatedById: actor.id } }));
      await tx.managementReport.update({ where: { id: row.id }, data: { status: 'FINAL', snapshot: snapshot as unknown as Prisma.InputJsonValue, finalisedById: actor.id, finalisedAt: new Date(), updatedById: actor.id } });
      const net = snapshot.lines.find((l) => l.key === 'netIncome')!;
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'management_report.finalised', entityType: 'management_report', entityId: row.id, data: { month, netIncome: net.actual, closingCash: snapshot.cash.closing } });
    });
    return this.report(orgId, month);
  }
}
