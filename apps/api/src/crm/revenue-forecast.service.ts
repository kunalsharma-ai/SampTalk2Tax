import { Injectable, NotFoundException } from '@nestjs/common';
import { D, forecastMonths, minorUnits, revenueForecast, revenueForecastAccuracy, type ContractFrequency, type ForecastItem, type ForecastMonth } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService, Tx } from '../common/prisma.service';

export interface ForecastOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
const pad = (p: string, n: number) => `${p}-${String(n).padStart(4, '0')}`;
const n = (v: Prisma.Decimal | string | number | null | undefined) => new D(v == null ? 0 : v.toString());

/** Revenue forecast from contracts, open orders, the pipeline and recent sales; saved forecasts and their accuracy. */
@Injectable()
export class RevenueForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async forecast(org: ForecastOrg, months: number, today = todayIso()) {
    const s = minorUnits(org.functionalCurrency);
    const first = forecastMonths(today, 1)[0]!;
    // The three complete months before this one.
    const [y, m] = first.split('-').map(Number) as [number, number];
    const t = y * 12 + (m - 1) - 3;
    const runFrom = toDbDate(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`);
    const [contracts, orderLines, deals, revenue] = await Promise.all([
      this.prisma.salesContract.findMany({
        where: { orgId: org.id, status: 'ACTIVE' },
        select: { id: true, number: true, title: true, contactId: true, startDate: true, endDate: true, frequency: true, timing: true, nextPeriodNo: true, autoRenew: true, subtotal: true },
        orderBy: { number: 'asc' },
      }),
      this.openOrderLines(org.id),
      this.prisma.crmDeal.findMany({
        where: { orgId: org.id, stage: { in: ['PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION'] } },
        select: { id: true, number: true, name: true, contactId: true, amount: true, probability: true, expectedCloseDate: true },
      }),
      // Revenue by month and whether it came from a contract or an order.
      this.revenueLines(this.prisma, org.id, runFrom, toDbDate(today)).then((rows) => this.byMonthAndSource(org.id, rows)),
    ]);
    const contactIds = [...new Set([...contracts.map((c) => c.contactId), ...orderLines.map((o) => o.contact_id), ...deals.map((d) => d.contactId)])];
    const names = new Map((await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: contactIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));

    const orders = new Map<string, { id: string; reference: string; customer: string; remaining: InstanceType<typeof D> }>();
    for (const l of orderLines) {
      const o = orders.get(l.order_id) ?? { id: l.order_id, reference: pad('SO', l.number), customer: names.get(l.contact_id) ?? '', remaining: new D(0) };
      const left = D.max(n(l.quantity).minus(l.billed.toString()), 0);
      if (n(l.quantity).gt(0)) o.remaining = o.remaining.plus(n(l.net_amount).times(left).div(l.quantity.toString()));
      orders.set(l.order_id, o);
    }
    const thisMonth = revenue.filter((r) => r.month === first);
    const prior = revenue.filter((r) => r.month < first && r.other);
    const runRate = prior.reduce((t, r) => t.plus(r.revenue.toString()), new D(0)).div(3);
    const result = revenueForecast({
      today,
      months,
      contracts: contracts.map((c) => ({
        id: c.id,
        reference: pad('CT', c.number),
        title: c.title,
        customer: names.get(c.contactId) ?? '',
        start: fromDbDate(c.startDate),
        end: c.endDate ? fromDbDate(c.endDate) : null,
        frequency: c.frequency as ContractFrequency,
        timing: c.timing,
        nextNo: c.nextPeriodNo,
        autoRenew: c.autoRenew,
        perPeriod: c.subtotal.toFixed(),
      })),
      orders: [...orders.values()].map((o) => ({ ...o, remaining: o.remaining.toDecimalPlaces(s).toFixed() })),
      deals: deals.map((d) => ({ id: d.id, reference: pad('DL', d.number), name: d.name, customer: names.get(d.contactId) ?? '', amount: d.amount.toFixed(), probability: d.probability, expectedClose: fromDbDate(d.expectedCloseDate) })),
      otherRunRate: runRate.toDecimalPlaces(s).toFixed(),
      otherSoFar: thisMonth.filter((r) => r.other).reduce((t, r) => t.plus(r.revenue.toString()), new D(0)).toFixed(),
      actualSoFar: thisMonth.reduce((t, r) => t.plus(r.revenue.toString()), new D(0)).toFixed(),
      scale: s,
    });
    return { asOf: today, currency: org.functionalCurrency, horizon: months, otherRunRate: runRate.toFixed(s), ...result, can: { save: hasPermission(org.role, 'sales.manage') } };
  }

  async save(org: ForecastOrg, actor: { id: string }, body: { months: number; note?: string | null }, today = todayIso()) {
    const f = await this.forecast(org, body.months, today);
    return this.prisma.$transaction(async (tx) => {
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'revenue_forecast', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
        RETURNING value`;
      const row = await tx.revenueForecast.create({
        data: {
          orgId: org.id,
          number: value,
          asOf: toDbDate(today),
          months: body.months,
          currency: org.functionalCurrency,
          actualSoFar: f.actualSoFar,
          committedTotal: f.totals.committed,
          expectedTotal: f.totals.expected,
          bestTotal: f.totals.best,
          data: { months: f.months, items: f.items, otherRunRate: f.otherRunRate } as unknown as Prisma.InputJsonValue,
          note: body.note?.trim() || null,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'revenue_forecast.saved', entityType: 'revenue_forecast', entityId: row.id, data: { reference: pad('RF', row.number), months: body.months, expected: f.totals.expected } });
      return this.get(org, row.id, today, tx);
    });
  }

  /** Saved forecasts, newest first, each with how it compares so far. */
  async list(org: ForecastOrg, today = todayIso()) {
    const rows = await this.prisma.revenueForecast.findMany({ where: { orgId: org.id }, orderBy: { number: 'desc' }, take: 100 });
    const actual = await this.actualByMonth(org, rows.length ? fromDbDate(rows.at(-1)!.asOf) : today, today);
    const users = await this.userNames(rows.map((r) => r.createdById));
    return {
      forecasts: rows.map((r) => {
        const acc = this.accuracy(org, r, actual, today);
        return { id: r.id, reference: pad('RF', r.number), asOf: fromDbDate(r.asOf), months: r.months, committed: r.committedTotal.toFixed(minorUnits(org.functionalCurrency)), expected: r.expectedTotal.toFixed(minorUnits(org.functionalCurrency)), best: r.bestTotal.toFixed(minorUnits(org.functionalCurrency)), note: r.note, createdBy: users.get(r.createdById) ?? null, createdAt: r.createdAt.toISOString(), monthsOver: acc.months.length, wape: acc.wape };
      }),
    };
  }

  async get(org: ForecastOrg, id: string, today = todayIso(), db: Tx | PrismaService = this.prisma) {
    const r = await db.revenueForecast.findFirst({ where: { id, orgId: org.id } });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Saved forecast not found' });
    const actual = await this.actualByMonth(org, fromDbDate(r.asOf), today, db);
    const data = r.data as unknown as { months: ForecastMonth[]; items: ForecastItem[]; otherRunRate: string };
    const s = minorUnits(org.functionalCurrency);
    const by = await db.user.findUnique({ where: { id: r.createdById }, select: { name: true } });
    return {
      id: r.id,
      reference: pad('RF', r.number),
      asOf: fromDbDate(r.asOf),
      horizon: r.months,
      currency: r.currency,
      note: r.note,
      createdBy: by?.name ?? null,
      createdAt: r.createdAt.toISOString(),
      actualSoFar: r.actualSoFar.toFixed(s),
      otherRunRate: data.otherRunRate,
      totals: {
        ...Object.fromEntries((['contracts', 'orders', 'pipelineWeighted', 'pipelineFull', 'otherSales'] as const).map((k) => [k, data.months.reduce((t, m) => t.plus(m[k]), new D(0)).toFixed(s)])),
        committed: r.committedTotal.toFixed(s),
        expected: r.expectedTotal.toFixed(s),
        best: r.bestTotal.toFixed(s),
      } as Omit<ForecastMonth, 'month'>,
      months: data.months,
      items: data.items,
      accuracy: this.accuracy(org, r, actual, today),
    };
  }

  private accuracy(org: ForecastOrg, r: { asOf: Date; actualSoFar: Prisma.Decimal; data: Prisma.JsonValue }, actual: Map<string, string>, today: string) {
    const data = r.data as unknown as { months: ForecastMonth[] };
    return revenueForecastAccuracy(data.months, r.actualSoFar.toFixed(), actual, today.slice(0, 7), minorUnits(org.functionalCurrency));
  }

  private async actualByMonth(org: ForecastOrg, from: string, today: string, db: Tx | PrismaService = this.prisma) {
    const per = new Map<string, Prisma.Decimal>();
    for (const r of await this.revenueLines(db, org.id, toDbDate(`${from.slice(0, 7)}-01`), toDbDate(today))) per.set(r.month, (per.get(r.month) ?? new Prisma.Decimal(0)).plus(r.revenue));
    const rows = [...per.entries()].map(([month, revenue]) => ({ month, revenue }));
    return new Map(rows.map((r) => [r.month, r.revenue.toFixed()]));
  }

  /** Revenue lines of posted invoices (less credit notes) issued between the dates, per document, by month. */
  private async revenueLines(db: Tx | PrismaService, orgId: string, from: Date, to: Date) {
    const revenue = new Set((await db.account.findMany({ where: { orgId, type: 'REVENUE' }, select: { id: true } })).map((a) => a.id));
    const docs = await db.document.findMany({ where: { orgId, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: 'POSTED', issueDate: { gte: from, lte: to } }, select: { id: true, kind: true, issueDate: true, lines: { select: { accountId: true, netAmount: true } } } });
    return docs
      .map((d) => {
        const lines = d.lines.filter((l) => revenue.has(l.accountId));
        const sum = lines.reduce((t, l) => (d.kind === 'INVOICE' ? t.plus(l.netAmount) : t.minus(l.netAmount)), new Prisma.Decimal(0));
        return { documentId: d.id, month: fromDbDate(d.issueDate).slice(0, 7), revenue: sum, lines: lines.length };
      })
      .filter((r) => r.lines > 0);
  }

  /** Revenue by month and whether it came from a contract or an order (`other` when from neither). */
  private async byMonthAndSource(orgId: string, rows: { documentId: string; month: string; revenue: Prisma.Decimal }[]) {
    const ids = rows.map((r) => r.documentId);
    const [periods, billings] = ids.length
      ? await Promise.all([
          this.prisma.salesContractPeriod.findMany({ where: { orgId, documentId: { in: ids } }, select: { documentId: true } }),
          this.prisma.salesOrderBilling.findMany({ where: { orgId, documentId: { in: ids } }, select: { documentId: true } }),
        ])
      : [[], []];
    const linked = new Set([...periods.map((p) => p.documentId), ...billings.map((b) => b.documentId)]);
    const out = new Map<string, { month: string; other: boolean; revenue: Prisma.Decimal }>();
    for (const r of rows) {
      const other = !linked.has(r.documentId);
      const k = `${r.month}|${other}`;
      out.set(k, { month: r.month, other, revenue: (out.get(k)?.revenue ?? new Prisma.Decimal(0)).plus(r.revenue) });
    }
    return [...out.values()];
  }

  /** Lines of open sales orders with the quantity billed on documents that are not void. */
  private async openOrderLines(orgId: string) {
    const lines = await this.prisma.salesOrderLine.findMany({ where: { orgId, order: { status: 'OPEN' } }, select: { id: true, quantity: true, netAmount: true, order: { select: { id: true, number: true, contactId: true } } } });
    const billings = lines.length ? await this.prisma.salesOrderBilling.findMany({ where: { orgId, orderLineId: { in: lines.map((l) => l.id) } }, select: { orderLineId: true, documentId: true, quantity: true } }) : [];
    const voided = new Set((billings.length ? await this.prisma.document.findMany({ where: { orgId, id: { in: [...new Set(billings.map((b) => b.documentId))] }, status: 'VOID' }, select: { id: true } }) : []).map((d) => d.id));
    return lines.map((l) => ({
      order_id: l.order.id,
      number: l.order.number,
      contact_id: l.order.contactId,
      quantity: l.quantity,
      net_amount: l.netAmount,
      billed: billings.filter((b) => b.orderLineId === l.id && !voided.has(b.documentId)).reduce((t, b) => t.plus(b.quantity), new Prisma.Decimal(0)),
    }));
  }

  private async userNames(ids: string[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
