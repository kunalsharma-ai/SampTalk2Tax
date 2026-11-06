import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, fiscalYearLabel, minorUnits, YearEndError, yearEndClosing, yearEndStatus, yearProfit, type YearEndAccount } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';

type Actor = { id: string };
export interface YearEndOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}

export const yearEndRef = (n: number) => `YE-${String(n).padStart(4, '0')}`;

interface Row {
  account_id: string;
  code: string;
  name: string;
  type: 'REVENUE' | 'EXPENSE';
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  closing_debit: Prisma.Decimal;
  closing_credit: Prisma.Decimal;
}

/**
 * Year-end close (GL-011): a fiscal year's revenue and expense accounts brought to nil and the
 * year's profit or loss moved to retained earnings, by a CLOSING journal (source YEAR_END) dated
 * the year's last day. Profit-and-loss reports leave closing journals out, so the year's income
 * statement is unchanged; the balance sheet then shows the profit in retained earnings.
 *
 * Closing again after a late change posts only what is left. Reopening a year reverses its closes
 * (the reversals are closing journals too), which brings the accounts back as they were.
 */
@Injectable()
export class YearEndService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  can(org: YearEndOrg) {
    return { close: hasPermission(org.role, 'close.manage') && hasPermission(org.role, 'journals.post') };
  }

  /** Every fiscal year with its profit, what is left to close, its status, and the closes made. */
  async overview(org: YearEndOrg) {
    const scale = minorUnits(org.functionalCurrency);
    const today = todayIso();
    const periods = await this.prisma.fiscalPeriod.findMany({ where: { orgId: org.id }, orderBy: { startDate: 'asc' } });
    const years = new Map<number, typeof periods>();
    for (const p of periods) years.set(p.fiscalYear, [...(years.get(p.fiscalYear) ?? []), p]);
    const closes = await this.closes(org);
    const out = [];
    for (const [fiscalYear, ps] of years) {
      const startDate = fromDbDate(ps[0]!.startDate);
      const endDate = fromDbDate(ps[ps.length - 1]!.endDate);
      const rows = await this.balances(this.prisma, org.id, startDate, endDate);
      const left = yearEndClosing(this.accounts(rows, true), '00000000-0000-0000-0000-000000000000', '', org.functionalCurrency);
      const active = closes.filter((c) => c.fiscalYear === fiscalYear && c.status === 'ACTIVE');
      const last = ps[ps.length - 1]!;
      out.push({
        fiscalYear,
        label: fiscalYearLabel(startDate, org.fiscalYearStartMonth),
        startDate,
        endDate,
        ended: endDate < today,
        lastPeriod: { id: last.id, name: last.name, status: last.status },
        periods: { open: ps.filter((p) => p.status === 'OPEN').length, locked: ps.filter((p) => p.status === 'LOCKED').length, closed: ps.filter((p) => p.status === 'CLOSED').length },
        profit: yearProfit(this.accounts(rows, false), org.functionalCurrency),
        closedToRetainedEarnings: active.reduce((s, c) => s.plus(c.toRetainedEarnings), new D(0)).toFixed(scale),
        leftToClose: left.toRetainedEarnings,
        accountsLeft: left.accounts,
        status: yearEndStatus({ hasActiveClose: active.length > 0, accountsLeft: left.accounts }),
      });
    }
    const suggested = await this.prisma.account.findFirst({ where: { orgId: org.id, type: 'EQUITY', subtype: 'RETAINED_EARNINGS', isPostable: true, isActive: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } });
    const lastUsed = closes[0] ? { id: closes[0].retainedEarningsAccount.id } : null;
    return {
      currency: org.functionalCurrency,
      years: out.reverse(),
      closes,
      retainedEarningsAccountId: lastUsed?.id ?? suggested?.id ?? null,
      can: this.can(org),
    };
  }

  /** What closing the year now would post, line by line, without posting it. */
  async preview(org: YearEndOrg, fiscalYear: number, retainedEarningsAccountId?: string) {
    const year = await this.year(this.prisma, org.id, fiscalYear);
    const rows = await this.balances(this.prisma, org.id, year.startDate, year.endDate);
    const re = retainedEarningsAccountId ?? (await this.overview(org)).retainedEarningsAccountId ?? '00000000-0000-0000-0000-000000000000';
    const closing = this.closing(rows, re, fiscalYearLabel(year.startDate, org.fiscalYearStartMonth), org.functionalCurrency);
    const names = new Map(rows.map((r) => [r.account_id, `${r.code} · ${r.name}`]));
    const reAccount = await this.prisma.account.findFirst({ where: { orgId: org.id, id: re }, select: { code: true, name: true } });
    if (reAccount) names.set(re, `${reAccount.code} · ${reAccount.name}`);
    return {
      fiscalYear,
      closingDate: year.endDate,
      profit: yearProfit(this.accounts(rows, false), org.functionalCurrency),
      toRetainedEarnings: closing.toRetainedEarnings,
      lines: closing.lines.map((l) => ({ ...l, account: names.get(l.accountId) ?? null })),
    };
  }

  /** Close the year: post what is left in its revenue and expense accounts to retained earnings. */
  async close(org: YearEndOrg, actor: Actor, fiscalYear: number, input: { retainedEarningsAccountId: string; memo?: string | null }) {
    this.assertClose(org);
    const id = await this.prisma.$transaction(async (tx) => {
      // One close of a year at a time: hold its last period.
      const year = await this.year(tx, org.id, fiscalYear, true);
      if (year.endDate >= todayIso()) throw new DomainError('YEAR_NOT_ENDED', `${fiscalYearLabel(year.startDate, org.fiscalYearStartMonth)} ends on ${year.endDate}; close it after that day`, HttpStatus.CONFLICT);
      const re = await tx.account.findFirst({ where: { orgId: org.id, id: input.retainedEarningsAccountId } });
      if (!re) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
      if (re.type !== 'EQUITY' || !re.isPostable || !re.isActive) throw new DomainError('RE_ACCOUNT', 'Retained earnings must be an active, postable equity account', HttpStatus.UNPROCESSABLE_ENTITY);
      const rows = await this.balances(tx, org.id, year.startDate, year.endDate);
      const label = fiscalYearLabel(year.startDate, org.fiscalYearStartMonth);
      const closing = this.closing(rows, re.id, label, org.functionalCurrency);
      if (closing.lines.length === 0) throw new DomainError('NOTHING_TO_CLOSE', `${label} has nothing left in its revenue and expense accounts`, HttpStatus.CONFLICT);
      const [{ value: number }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'year_end_close', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1 RETURNING value`;
      const again = (await tx.yearEndClose.count({ where: { orgId: org.id, fiscalYear, status: 'ACTIVE' } })) > 0;
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date: year.endDate,
        source: 'YEAR_END',
        type: 'CLOSING',
        reference: yearEndRef(number),
        memo: input.memo?.trim() || `${label} closed to retained earnings${again ? ' (after later changes)' : ''}`,
        lines: closing.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })),
      });
      const profit = yearProfit(this.accounts(rows, false), org.functionalCurrency);
      const c = await tx.yearEndClose.create({
        data: {
          orgId: org.id,
          number,
          fiscalYear,
          closingDate: toDbDate(year.endDate),
          retainedEarningsAccountId: re.id,
          profit,
          toRetainedEarnings: closing.toRetainedEarnings,
          accounts: closing.accounts,
          journalEntryId: je.id,
          memo: input.memo?.trim() || null,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'year_end.closed', entityType: 'year_end_close', entityId: c.id, data: { reference: yearEndRef(number), fiscalYear, profit, toRetainedEarnings: closing.toRetainedEarnings, accounts: closing.accounts, journalEntryId: je.id } });
      return c.id;
    });
    return (await this.closes(org, id))[0]!;
  }

  /** Reopen a closed year: reverse every close of it still in force, dated the year's last day. */
  async reopen(org: YearEndOrg, actor: Actor, fiscalYear: number, input: { reason: string }) {
    this.assertClose(org);
    const ids = await this.prisma.$transaction(async (tx) => {
      const year = await this.year(tx, org.id, fiscalYear, true);
      const active = await tx.yearEndClose.findMany({ where: { orgId: org.id, fiscalYear, status: 'ACTIVE' }, orderBy: { number: 'desc' } });
      if (active.length === 0) throw new DomainError('NOT_CLOSED', `${fiscalYearLabel(year.startDate, org.fiscalYearStartMonth)} is not closed`, HttpStatus.CONFLICT);
      for (const c of active) {
        const rev = await this.journals.reverseSystemEntry(tx, org, actor, c.journalEntryId, { date: year.endDate, memo: `${yearEndRef(c.number)} reversed: ${input.reason.trim()}` });
        await tx.yearEndClose.update({ where: { id: c.id }, data: { status: 'REVERSED', reversedOn: toDbDate(year.endDate), reversalReason: input.reason.trim(), reversalJournalEntryId: rev.id, reversedById: actor.id } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'year_end.reopened', entityType: 'year_end_close', entityId: c.id, data: { reference: yearEndRef(c.number), fiscalYear, reason: input.reason.trim(), reversalJournalEntryId: rev.id } });
      }
      return active.map((c) => c.id);
    });
    const all = await this.closes(org);
    return all.filter((c) => ids.includes(c.id));
  }

  async closes(org: YearEndOrg, id?: string) {
    const scale = minorUnits(org.functionalCurrency);
    const rows = await this.prisma.yearEndClose.findMany({ where: { orgId: org.id, ...(id ? { id } : {}) }, orderBy: { number: 'desc' } });
    const accountIds = [...new Set(rows.map((r) => r.retainedEarningsAccountId))];
    const accounts = accountIds.length ? await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: accountIds } }, select: { id: true, code: true, name: true } }) : [];
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.createdById, r.reversedById].filter((x): x is string => !!x)))] } }, select: { id: true, name: true } });
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const who = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      reference: yearEndRef(r.number),
      fiscalYear: r.fiscalYear,
      label: fiscalYearLabel(fromDbDate(r.closingDate), org.fiscalYearStartMonth),
      closingDate: fromDbDate(r.closingDate),
      retainedEarningsAccount: acc.get(r.retainedEarningsAccountId)!,
      profit: r.profit.toFixed(scale),
      toRetainedEarnings: r.toRetainedEarnings.toFixed(scale),
      accounts: r.accounts,
      journalEntryId: r.journalEntryId,
      memo: r.memo,
      status: r.status,
      reversedOn: r.reversedOn ? fromDbDate(r.reversedOn) : null,
      reversalReason: r.reversalReason,
      reversalJournalEntryId: r.reversalJournalEntryId,
      createdBy: who.get(r.createdById) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ---------- helpers ----------

  private closing(rows: Row[], re: string, label: string, currency: string) {
    try {
      return yearEndClosing(this.accounts(rows, true), re, label, currency);
    } catch (e) {
      if (e instanceof YearEndError) throw new DomainError(e.code, e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
  }

  /** Revenue and expense movements of the year, with closing entries (`withClosing`) or without. */
  private accounts(rows: Row[], withClosing: boolean): YearEndAccount[] {
    return rows.map((r) => ({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      debit: (withClosing ? r.debit.plus(r.closing_debit) : r.debit).toFixed(),
      credit: (withClosing ? r.credit.plus(r.closing_credit) : r.credit).toFixed(),
    }));
  }

  private async balances(db: Tx | PrismaService, orgId: string, from: string, to: string): Promise<Row[]> {
    return db.$queryRaw<Row[]>`
      SELECT a.id AS account_id, a.code, a.name, a.type::text AS type,
             COALESCE(SUM(l.functional_debit) FILTER (WHERE e.type <> 'CLOSING'), 0) AS debit,
             COALESCE(SUM(l.functional_credit) FILTER (WHERE e.type <> 'CLOSING'), 0) AS credit,
             COALESCE(SUM(l.functional_debit) FILTER (WHERE e.type = 'CLOSING'), 0) AS closing_debit,
             COALESCE(SUM(l.functional_credit) FILTER (WHERE e.type = 'CLOSING'), 0) AS closing_credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
      JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = ${orgId}::uuid AND e.status = 'POSTED' AND a.type IN ('REVENUE', 'EXPENSE')
        AND e.date >= ${toDbDate(from)}::date AND e.date <= ${toDbDate(to)}::date
      GROUP BY a.id, a.code, a.name, a.type`;
  }

  private async year(db: Tx | PrismaService, orgId: string, fiscalYear: number, lock = false) {
    const ps = await db.fiscalPeriod.findMany({ where: { orgId, fiscalYear }, orderBy: { startDate: 'asc' } });
    if (ps.length === 0) throw new NotFoundException({ error: 'NOT_FOUND', message: `No fiscal year ${fiscalYear}` });
    const last = ps[ps.length - 1]!;
    if (lock) await db.$queryRaw`SELECT id FROM fiscal_periods WHERE id = ${last.id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    return { startDate: fromDbDate(ps[0]!.startDate), endDate: fromDbDate(last.endDate), lastPeriod: last };
  }

  private assertClose(org: YearEndOrg) {
    if (!this.can(org).close) throw new ForbiddenException({ error: 'FORBIDDEN', message: `Closing a year needs close.manage and journals.post, which your role (${org.role}) does not have` });
  }
}
