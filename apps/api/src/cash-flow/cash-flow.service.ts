import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDays,
  buildCashForecast,
  CashFlowInput,
  D,
  daysBetween,
  Dec,
  delayStats,
  DelayStats,
  expectedDates,
  forecastAccuracy,
  ForecastDay,
  Ledger,
  minorUnits,
  plannedDates,
  PlannedFrequency,
  sum,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { byCode, daysBetween as daysApart } from '../db/subledger-queries';
import { SubledgerService } from '../ledgers/subledger.service';

type Actor = { id: string };
/** Payment history looked at for delays: the year before the forecast date. */
const HISTORY_DAYS = 365;

/** Today's date in India (the forecast and saved-forecast checks use IST). */
export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export interface PlannedItemInput {
  name: string;
  direction: 'IN' | 'OUT';
  amount: string;
  frequency: PlannedFrequency;
  startDate: string;
  endDate?: string | null;
  note?: string | null;
  isActive?: boolean;
}

interface Basis {
  source: 'CONTACT' | 'ALL_CONTACTS' | 'DUE_DATE';
  stats: DelayStats | null;
}

@Injectable()
export class CashFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
    private readonly store: DocumentStoreService,
  ) {}

  private async currency(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    return { code: o.functionalCurrency, scale: minorUnits(o.functionalCurrency) };
  }

  // ------------------------------------------------------------------ settings and planned items

  async settings(orgId: string) {
    const [s, c] = await Promise.all([this.prisma.cashFlowSettings.findUnique({ where: { orgId } }), this.currency(orgId)]);
    return { minimumBalance: (s?.minimumBalance ?? new Prisma.Decimal(0)).toFixed(c.scale), currency: c.code };
  }

  async saveSettings(orgId: string, actor: Actor, input: { minimumBalance: string }) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.cashFlowSettings.findUnique({ where: { orgId } });
      await tx.cashFlowSettings.upsert({ where: { orgId }, create: { orgId, minimumBalance: new Prisma.Decimal(input.minimumBalance), updatedById: actor.id }, update: { minimumBalance: new Prisma.Decimal(input.minimumBalance), updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'cashflow.settings_saved', entityType: 'cash_flow_settings', entityId: orgId, data: { from: before?.minimumBalance.toFixed(2) ?? null, to: input.minimumBalance } });
    });
    return this.settings(orgId);
  }

  private item(i: { id: string; name: string; direction: 'IN' | 'OUT'; amount: Prisma.Decimal; frequency: PlannedFrequency; startDate: Date; endDate: Date | null; note: string | null; isActive: boolean; createdAt: Date; updatedAt: Date }, scale: number) {
    return { id: i.id, name: i.name, direction: i.direction, amount: i.amount.toFixed(scale), frequency: i.frequency, startDate: fromDbDate(i.startDate), endDate: i.endDate ? fromDbDate(i.endDate) : null, note: i.note, isActive: i.isActive, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString() };
  }

  async listItems(orgId: string) {
    const c = await this.currency(orgId);
    const items = await this.prisma.cashFlowItem.findMany({ where: { orgId }, orderBy: [{ isActive: 'desc' }, { startDate: 'asc' }, { name: 'asc' }] });
    return items.map((i) => this.item(i, c.scale));
  }

  private checkItem(input: PlannedItemInput) {
    if (input.frequency === 'ONCE' && input.endDate) throw new DomainError('INVALID_ITEM', 'A one-off item has no end date');
    if (input.endDate && input.endDate < input.startDate) throw new DomainError('INVALID_ITEM', 'The end date is before the start date');
  }

  async createItem(orgId: string, actor: Actor, input: PlannedItemInput) {
    this.checkItem(input);
    const c = await this.currency(orgId);
    const i = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cashFlowItem.create({
        data: { orgId, name: input.name, direction: input.direction, amount: new Prisma.Decimal(input.amount), frequency: input.frequency, startDate: toDbDate(input.startDate), endDate: input.endDate ? toDbDate(input.endDate) : null, note: input.note ?? null, isActive: input.isActive ?? true, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'cashflow.item_created', entityType: 'cash_flow_item', entityId: row.id, data: { name: row.name, direction: row.direction, amount: row.amount.toFixed(2), frequency: row.frequency, startDate: input.startDate, endDate: input.endDate ?? null } });
      return row;
    });
    return this.item(i, c.scale);
  }

  async updateItem(orgId: string, actor: Actor, id: string, input: PlannedItemInput) {
    this.checkItem(input);
    const c = await this.currency(orgId);
    const i = await this.prisma.$transaction(async (tx) => {
      const before = await tx.cashFlowItem.findFirst({ where: { id, orgId } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Planned item not found' });
      const row = await tx.cashFlowItem.update({
        where: { id },
        data: { name: input.name, direction: input.direction, amount: new Prisma.Decimal(input.amount), frequency: input.frequency, startDate: toDbDate(input.startDate), endDate: input.endDate ? toDbDate(input.endDate) : null, note: input.note ?? null, isActive: input.isActive ?? before.isActive },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'cashflow.item_updated', entityType: 'cash_flow_item', entityId: id, data: { before: this.item(before, 2), after: this.item(row, 2) } });
      return row;
    });
    return this.item(i, c.scale);
  }

  async deleteItem(orgId: string, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.cashFlowItem.findFirst({ where: { id, orgId } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Planned item not found' });
      await tx.cashFlowItem.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'cashflow.item_deleted', entityType: 'cash_flow_item', entityId: id, data: this.item(before, 2) });
    });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ inputs from the books

  /** Cash and bank accounts and their balances at the end of `asOf`. */
  private async cashAccounts(orgId: string, asOf: string) {
    const accounts = (await this.cashAccountList(orgId)).sort(byCode);
    const sums = accounts.length ? await lineSums(this.store, orgId, { entry: postedBetween(null, toDbDate(asOf)), line: { accountId: { $in: accounts.map((a) => a.id) } }, by: { accountId: 'lines.accountId' } }) : [];
    const bal = new Map(sums.map((r) => [r.key.accountId as string, r.debit.minus(r.credit)]));
    return accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: bal.get(a.id) ?? new D(0) }));
  }

  private cashAccountList(orgId: string) {
    return this.prisma.account.findMany({ where: { orgId, subtype: { in: ['CASH', 'BANK'] } }, select: { id: true, code: true, name: true } });
  }

  /** Closing cash of each day from `from` to `to`, from posted journals. */
  async dailyCash(orgId: string, from: string, to: string): Promise<Map<string, Dec>> {
    const out = new Map<string, Dec>();
    if (to < from) return out;
    const opening = sum((await this.cashAccounts(orgId, addDays(from, -1))).map((a) => a.balance));
    const ids = (await this.cashAccountList(orgId)).map((a) => a.id);
    const rows = ids.length ? await lineSums(this.store, orgId, { entry: postedBetween(toDbDate(from), toDbDate(to)), line: { accountId: { $in: ids } }, by: { date: 'date' } }) : [];
    const byDate = new Map(rows.map((r) => [fromDbDate(r.key.date as Date), r.debit.minus(r.credit)]));
    let bal = opening;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      bal = bal.plus(byDate.get(d) ?? 0);
      out.set(d, bal);
    }
    return out;
  }

  /**
   * Days between the due date and full settlement for invoices (or bills) settled in the year
   * before `asOf`, as the records stood on `asOf`.
   */
  private async delays(orgId: string, ledger: Ledger, asOf: string) {
    const kind = ledger === 'SALES' ? 'INVOICE' : 'BILL';
    const d = toDbDate(asOf);
    const since = toDbDate(addDays(asOf, -HISTORY_DAYS));
    const docs = await this.prisma.document.findMany({
      where: { orgId, kind, OR: [{ status: 'POSTED' }, { status: 'VOID', voidDate: { gt: d } }] },
      select: { id: true, contactId: true, dueDate: true, total: true },
    });
    const allocs = docs.length
      ? await this.prisma.allocation.findMany({ where: { orgId, targetId: { in: docs.map((x) => x.id) }, date: { lte: d }, OR: [{ removedOn: null }, { removedOn: { gt: d } }] }, select: { targetId: true, date: true, amount: true } })
      : [];
    const paid = new Map<string, { sum: Prisma.Decimal; last: Date }>();
    for (const a of allocs) {
      const p = paid.get(a.targetId);
      paid.set(a.targetId, { sum: (p?.sum ?? new Prisma.Decimal(0)).plus(a.amount), last: p && p.last > a.date ? p.last : a.date });
    }
    const rows = docs.flatMap((x) => {
      const p = paid.get(x.id);
      return p && p.sum.gte(x.total) && p.last > since ? [{ contact_id: x.contactId, delay: daysApart(x.dueDate!, p.last) }] : [];
    });
    const byContact = new Map<string, number[]>();
    for (const r of rows) byContact.set(r.contact_id, [...(byContact.get(r.contact_id) ?? []), Number(r.delay)]);
    const all = delayStats(rows.map((r) => Number(r.delay)));
    return {
      all,
      samples: rows.length,
      basis: (contactId: string): Basis => {
        const own = delayStats(byContact.get(contactId) ?? []);
        if (own) return { source: 'CONTACT', stats: own };
        if (all) return { source: 'ALL_CONTACTS', stats: all };
        return { source: 'DUE_DATE', stats: null };
      },
    };
  }

  // ------------------------------------------------------------------ the forecast

  /**
   * The forecast as of a date (today by default) from the records as they stood that day:
   * open invoices and bills with their expected settlement dates, active planned items, and
   * cash and bank balances.
   */
  async forecast(orgId: string, q: { asOf?: string; horizonDays: number }) {
    const today = todayIst();
    const asOf = q.asOf ?? today;
    if (asOf > today) throw new DomainError('INVALID_DATE', 'A forecast starts from today or an earlier day');
    if (daysBetween(asOf, today) > 730) throw new DomainError('INVALID_DATE', 'Backtests go back at most two years');
    const c = await this.currency(orgId);
    const f = (x: Dec) => x.toFixed(c.scale);
    const [accounts, settings, items, ar, ap, arDelays, apDelays] = await Promise.all([
      this.cashAccounts(orgId, asOf),
      this.prisma.cashFlowSettings.findUnique({ where: { orgId } }),
      this.prisma.cashFlowItem.findMany({ where: { orgId, isActive: true } }),
      this.subledger.openItems(this.prisma, orgId, 'SALES', asOf),
      this.subledger.openItems(this.prisma, orgId, 'PURCHASES', asOf),
      this.delays(orgId, 'SALES', asOf),
      this.delays(orgId, 'PURCHASES', asOf),
    ]);
    const opening = sum(accounts.map((a) => a.balance));
    const end = addDays(asOf, q.horizonDays);
    const flows: CashFlowInput[] = [];

    const open = (items: typeof ar, ledger: Ledger, delays: typeof arDelays) =>
      items
        .filter((i) => i.type === 'charge')
        .map((i) => {
          const basis = delays.basis(i.contactId);
          const due = i.dueDate ?? i.date;
          const dates = expectedDates(due, asOf, basis.stats);
          const doubtful = ledger === 'SALES' && dates.doubtful;
          flows.push({ amount: ledger === 'SALES' ? i.open : i.open.negated(), category: ledger === 'SALES' ? 'RECEIVABLE' : 'PAYABLE', dates, doubtful, ref: i.id });
          return {
            id: i.id,
            contactId: i.contactId,
            contactName: i.contactName,
            number: i.number,
            dueDate: due,
            open: f(i.open),
            expected: { early: dates.early, base: dates.base, late: dates.late },
            inHorizon: dates.base <= end,
            pastTypical: dates.pastTypical,
            doubtful,
            basis: { source: basis.source, samples: basis.stats?.count ?? 0, medianDelay: basis.stats?.median ?? null },
          };
        })
        .sort((a, b) => a.expected.base.localeCompare(b.expected.base) || a.number.localeCompare(b.number));
    const receivables = open(ar, 'SALES', arDelays);
    const payables = open(ap, 'PURCHASES', apDelays);
    const unapplied = (items: typeof ar) => f(sum(items.filter((i) => i.type !== 'charge').map((i) => i.open)));

    const planned: { itemId: string; name: string; direction: 'IN' | 'OUT'; date: string; amount: string }[] = [];
    for (const it of items) {
      for (const date of plannedDates({ startDate: fromDbDate(it.startDate), endDate: it.endDate ? fromDbDate(it.endDate) : null, frequency: it.frequency }, addDays(asOf, 1), end)) {
        const amt = new D(it.amount.toFixed());
        flows.push({ amount: it.direction === 'IN' ? amt : amt.negated(), category: it.direction === 'IN' ? 'PLANNED_IN' : 'PLANNED_OUT', dates: { early: date, base: date, late: date }, ref: it.id });
        planned.push({ itemId: it.id, name: it.name, direction: it.direction, date, amount: f(amt) });
      }
    }
    planned.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

    const minimumBalance = settings?.minimumBalance ? new D(settings.minimumBalance.toFixed()) : null;
    const forecast = buildCashForecast({ asOf, horizonDays: q.horizonDays, opening, flows, buffer: minimumBalance && minimumBalance.greaterThan(0) ? minimumBalance : null, scale: c.scale });
    const stat = (s: DelayStats | null, samples: number) => (s ? { samples, p25: s.p25, median: s.median, p75: s.p75 } : { samples, p25: null, median: null, p75: null });
    return {
      currency: c.code,
      today,
      isBacktest: asOf < today,
      horizonDays: q.horizonDays,
      minimumBalance: minimumBalance ? f(minimumBalance) : f(new D(0)),
      cashAccounts: accounts.map((a) => ({ ...a, balance: f(a.balance) })),
      ...forecast,
      receivables,
      payables,
      planned,
      unapplied: { receipts: unapplied(ar), payments: unapplied(ap) },
      delays: { customers: stat(arDelays.all, arDelays.samples), vendors: stat(apDelays.all, apDelays.samples) },
    };
  }

  // ------------------------------------------------------------------ saved forecasts

  async save(orgId: string, actor: Actor, input: { asOf?: string; horizonDays: number; note?: string | null }) {
    const fc = await this.forecast(orgId, input);
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.cashForecast.create({
        data: {
          orgId,
          asOf: toDbDate(fc.asOf),
          horizonDays: fc.horizonDays,
          isBacktest: fc.isBacktest,
          opening: new Prisma.Decimal(fc.opening),
          closingBase: new Prisma.Decimal(fc.closing.base),
          minimumBalance: new Prisma.Decimal(fc.minimumBalance),
          days: fc.days as unknown as Prisma.InputJsonValue,
          inputs: {
            totals: fc.totals,
            closing: fc.closing,
            lowest: fc.lowest,
            belowBuffer: fc.belowBuffer,
            receivables: fc.receivables.length,
            payables: fc.payables.length,
            planned: fc.planned.length,
            delays: fc.delays,
          } as unknown as Prisma.InputJsonValue,
          note: input.note ?? null,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: fc.isBacktest ? 'cashflow.backtest_saved' : 'cashflow.forecast_saved', entityType: 'cash_forecast', entityId: r.id, data: { asOf: fc.asOf, horizonDays: fc.horizonDays, opening: fc.opening, closing: fc.closing } });
      return r;
    });
    return this.getSaved(orgId, row.id);
  }

  private async accuracyOf(orgId: string, asOf: string, days: ForecastDay[], scale: number) {
    const today = todayIst();
    const from = addDays(asOf, 1);
    const to = days[days.length - 1].date < today ? days[days.length - 1].date : today;
    const actual = await this.dailyCash(orgId, from, to);
    return forecastAccuracy(days, actual, scale);
  }

  async listSaved(orgId: string) {
    const c = await this.currency(orgId);
    const rows = await this.prisma.cashForecast.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const who = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return Promise.all(
      rows.map(async (r) => {
        const a = await this.accuracyOf(orgId, fromDbDate(r.asOf), r.days as unknown as ForecastDay[], c.scale);
        return {
          id: r.id,
          asOf: fromDbDate(r.asOf),
          horizonDays: r.horizonDays,
          isBacktest: r.isBacktest,
          opening: r.opening.toFixed(c.scale),
          closingBase: r.closingBase.toFixed(c.scale),
          note: r.note,
          createdBy: who.get(r.createdById) ?? 'Former member',
          createdAt: r.createdAt.toISOString(),
          accuracy: { days: a.days, meanAbsoluteError: a.meanAbsoluteError, bias: a.bias, withinRange: a.withinRange },
        };
      }),
    );
  }

  async getSaved(orgId: string, id: string) {
    const c = await this.currency(orgId);
    const r = await this.prisma.cashForecast.findFirst({ where: { id, orgId } });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Saved forecast not found' });
    const days = r.days as unknown as ForecastDay[];
    const accuracy = await this.accuracyOf(orgId, fromDbDate(r.asOf), days, c.scale);
    const who = await this.prisma.user.findUnique({ where: { id: r.createdById }, select: { name: true } });
    return {
      currency: c.code,
      id: r.id,
      asOf: fromDbDate(r.asOf),
      horizonDays: r.horizonDays,
      isBacktest: r.isBacktest,
      opening: r.opening.toFixed(c.scale),
      closingBase: r.closingBase.toFixed(c.scale),
      minimumBalance: r.minimumBalance?.toFixed(c.scale) ?? null,
      note: r.note,
      inputs: r.inputs,
      createdBy: who?.name ?? 'Former member',
      createdAt: r.createdAt.toISOString(),
      days,
      accuracy,
    };
  }

  /** Not exposed as a route: guards against a horizon the caller did not validate. */
  static checkHorizon(h: number) {
    if (![30, 60, 90, 180, 365].includes(h)) throw new DomainError('INVALID_HORIZON', 'The horizon is 30, 60, 90, 180 or 365 days', HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
