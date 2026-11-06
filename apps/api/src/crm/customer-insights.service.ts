import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDays,
  creditRisk,
  D,
  FREQUENCY_MONTHS,
  grossProfit,
  lifetimeValue,
  minorUnits,
  monthRange,
  paymentBehaviour,
  retention,
  type ContractFrequency,
  type InvoiceFact,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

export interface InsightOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
type Actor = { id: string };
type Num = Prisma.Decimal | null;
const n = (v: Num | string | undefined) => new D(v == null ? 0 : v.toString());

/** Customer 360: profitability, payment behaviour, lifetime value and credit risk, from the books. */
@Injectable()
export class CustomerInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every customer with history, ranked by lifetime value, and the organisation's retention. */
  async list(org: InsightOrg, today = todayIso()) {
    const data = await this.gather(org, today);
    const rows = data.customers
      .map((c) => this.assess(org, data, c, today))
      .filter((r) => r.invoices > 0 || r.contracts.active > 0 || !n(r.toDate.cost).isZero() || r.creditHold)
      .map((r) => ({
        contactId: r.contactId,
        name: r.name,
        revenue: r.toDate.revenue,
        cost: r.toDate.cost,
        profit: r.toDate.profit,
        margin: r.toDate.margin,
        trailingRevenue: r.trailing.revenue,
        lifetimeValue: r.lifetime.value,
        open: r.behaviour.open,
        overdue: r.behaviour.overdue,
        averageDaysToPay: r.behaviour.averageDaysToPay,
        risk: { score: r.risk.score, rating: r.risk.rating },
        creditLimit: r.creditLimit,
        creditHold: r.creditHold,
        contractArr: r.contracts.arr,
      }))
      .sort((a, b) => n(b.lifetimeValue).cmp(n(a.lifetimeValue)) || a.name.localeCompare(b.name));
    const s = minorUnits(org.functionalCurrency);
    const sum = (k: 'revenue' | 'profit' | 'lifetimeValue') => rows.reduce((t, r) => t.plus(r[k]), new D(0)).toFixed(s);
    const ratings: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, VERY_HIGH: 0, NO_HISTORY: 0 };
    for (const r of rows) ratings[r.risk.rating]!++;
    return {
      asOf: today,
      currency: org.functionalCurrency,
      retention: data.retention,
      summary: { customers: rows.length, revenue: sum('revenue'), profit: sum('profit'), lifetimeValue: sum('lifetimeValue'), onHold: rows.filter((r) => r.creditHold).length, ratings },
      customers: rows,
    };
  }

  /** One customer's 360 view. */
  async get(org: InsightOrg, contactId: string, today = todayIso()) {
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, orgId: org.id }, select: { id: true, isCustomer: true, creditHoldById: true } });
    if (!contact) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Customer not found' });
    if (!contact.isCustomer) throw new DomainError('NOT_A_CUSTOMER', 'This contact is not a customer', HttpStatus.UNPROCESSABLE_ENTITY);
    const data = await this.gather(org, today, contactId);
    const c = data.customers[0]!;
    const r = this.assess(org, data, c, today);
    const holdBy = contact.creditHoldById ? await this.prisma.user.findUnique({ where: { id: contact.creditHoldById }, select: { name: true } }) : null;
    return {
      ...r,
      creditHoldBy: holdBy?.name ?? null,
      retention: data.retention,
      can: { manage: hasPermission(org.role, 'contacts.manage') },
    };
  }

  async setCreditHold(org: InsightOrg, actor: Actor, contactId: string, body: { hold: boolean; reason?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM contacts WHERE id = ${contactId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      if (!rows.length) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Customer not found' });
      const c = await tx.contact.findUniqueOrThrow({ where: { id: contactId } });
      if (!c.isCustomer) throw new DomainError('NOT_A_CUSTOMER', 'Only customers can be put on credit hold', HttpStatus.UNPROCESSABLE_ENTITY);
      const reason = body.reason?.trim() || null;
      if (body.hold) {
        if (c.creditHold) throw new DomainError('ALREADY_ON_HOLD', `${c.name} is already on credit hold`, HttpStatus.CONFLICT);
        if (!reason) throw new DomainError('REASON_REQUIRED', 'Say why the customer is on hold', HttpStatus.UNPROCESSABLE_ENTITY);
        await tx.contact.update({ where: { id: contactId }, data: { creditHold: true, creditHoldReason: reason, creditHoldAt: new Date(), creditHoldById: actor.id } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.credit_hold_set', entityType: 'contact', entityId: contactId, data: { reason } });
      } else {
        if (!c.creditHold) throw new DomainError('NOT_ON_HOLD', `${c.name} is not on credit hold`, HttpStatus.CONFLICT);
        await tx.contact.update({ where: { id: contactId }, data: { creditHold: false, creditHoldReason: null, creditHoldAt: null, creditHoldById: null } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.credit_hold_lifted', entityType: 'contact', entityId: contactId, data: { reason, wasReason: c.creditHoldReason } });
      }
      return { contactId, creditHold: body.hold, creditHoldReason: body.hold ? reason : null };
    });
  }

  // ------------------------------------------------------------------ data

  private async gather(org: InsightOrg, today: string, contactId?: string) {
    const only = contactId ? Prisma.sql`AND x.contact_id = ${contactId}::uuid` : Prisma.empty;
    const asOf = toDbDate(today);
    const [customers, invoices, revenue, costs, projects, contracts, windows] = await Promise.all([
      this.prisma.contact.findMany({
        where: { orgId: org.id, isCustomer: true, ...(contactId ? { id: contactId } : {}) },
        select: { id: true, name: true, creditLimit: true, paymentTermsDays: true, creditHold: true, creditHoldReason: true, creditHoldAt: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
      // Posted invoices with what has been applied to them, and the day the last of it was applied.
      this.prisma.$queryRaw<{ id: string; contact_id: string; number: string; issue_date: Date; due_date: Date; total: Prisma.Decimal; applied: Prisma.Decimal; last_applied: Date | null }[]>`
        SELECT x.id, x.contact_id, x.number, x.issue_date, x.due_date, x.total,
               COALESCE(SUM(a.amount), 0) AS applied, MAX(a.date) AS last_applied
        FROM documents x
        LEFT JOIN allocations a ON a.target_id = x.id AND a.org_id = x.org_id AND a.removed_on IS NULL AND a.date <= ${asOf}::date
        WHERE x.org_id = ${org.id}::uuid AND x.kind = 'INVOICE' AND x.status = 'POSTED' AND x.issue_date <= ${asOf}::date ${only}
        GROUP BY x.id`,
      // Revenue by month: income lines on posted invoices, less posted credit notes.
      this.prisma.$queryRaw<{ contact_id: string; month: string; revenue: Prisma.Decimal; billed: Prisma.Decimal }[]>`
        SELECT x.contact_id, to_char(x.issue_date, 'YYYY-MM') AS month,
               SUM(CASE WHEN x.kind = 'INVOICE' THEN l.net_amount ELSE -l.net_amount END) AS revenue,
               SUM(CASE WHEN x.kind = 'INVOICE' THEN l.net_amount ELSE 0 END) AS billed
        FROM documents x
        JOIN document_lines l ON l.document_id = x.id AND l.org_id = x.org_id
        JOIN accounts acc ON acc.id = l.account_id AND acc.org_id = l.org_id
        WHERE x.org_id = ${org.id}::uuid AND x.kind IN ('INVOICE', 'CREDIT_NOTE') AND x.status = 'POSTED'
          AND acc.type = 'REVENUE' AND x.issue_date <= ${asOf}::date ${only}
        GROUP BY x.contact_id, month`,
      // Direct costs by month: expenses posted to the customer's projects.
      this.prisma.$queryRaw<{ contact_id: string; month: string; cost: Prisma.Decimal }[]>`
        SELECT x.contact_id, to_char(e.date, 'YYYY-MM') AS month, SUM(l.functional_debit - l.functional_credit) AS cost
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
        JOIN accounts acc ON acc.id = l.account_id AND acc.org_id = l.org_id
        JOIN dimension_values x ON x.id = l.project_id AND x.org_id = l.org_id
        WHERE l.org_id = ${org.id}::uuid AND e.status = 'POSTED' AND acc.type = 'EXPENSE' AND x.contact_id IS NOT NULL
          AND e.date <= ${asOf}::date ${only}
        GROUP BY x.contact_id, month`,
      this.prisma.$queryRaw<{ id: string; contact_id: string; code: string; name: string; is_active: boolean; cost: Prisma.Decimal }[]>`
        SELECT x.id, x.contact_id, x.code, x.name, x.is_active,
               COALESCE((SELECT SUM(l.functional_debit - l.functional_credit)
                         FROM journal_lines l
                         JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
                         JOIN accounts acc ON acc.id = l.account_id AND acc.org_id = l.org_id
                         WHERE l.org_id = x.org_id AND l.project_id = x.id AND e.status = 'POSTED' AND acc.type = 'EXPENSE' AND e.date <= ${asOf}::date), 0) AS cost
        FROM dimension_values x
        WHERE x.org_id = ${org.id}::uuid AND x.type = 'PROJECT' AND x.contact_id IS NOT NULL ${only}
        ORDER BY x.code`,
      this.prisma.salesContract.findMany({
        where: { orgId: org.id, status: { in: ['ACTIVE', 'PAUSED'] }, ...(contactId ? { contactId } : {}) },
        select: { id: true, contactId: true, number: true, title: true, status: true, frequency: true, subtotal: true, endDate: true },
        orderBy: { number: 'asc' },
      }),
      // Customers billed in the twelve months before last, and in the last twelve months (for retention).
      this.prisma.$queryRaw<{ contact_id: string; w: number }[]>`
        SELECT DISTINCT x.contact_id, CASE WHEN x.issue_date > ${toDbDate(addDays(today, -365))}::date THEN 1 ELSE 0 END AS w
        FROM documents x
        WHERE x.org_id = ${org.id}::uuid AND x.kind = 'INVOICE' AND x.status = 'POSTED'
          AND x.issue_date > ${toDbDate(addDays(today, -730))}::date AND x.issue_date <= ${asOf}::date`,
    ]);
    const prev = new Set(windows.filter((w) => Number(w.w) === 0).map((w) => w.contact_id));
    const last = new Set(windows.filter((w) => Number(w.w) === 1).map((w) => w.contact_id));
    const group = <T extends { contact_id: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r.contact_id, [...(m.get(r.contact_id) ?? []), r]);
      return m;
    };
    const contractsBy = new Map<string, typeof contracts>();
    for (const c of contracts) contractsBy.set(c.contactId, [...(contractsBy.get(c.contactId) ?? []), c]);
    return { customers, invoices: group(invoices), revenue: group(revenue), costs: group(costs), projects: group(projects), contracts: contractsBy, retention: retention(prev, last) };
  }

  private assess(org: InsightOrg, data: Awaited<ReturnType<CustomerInsightsService['gather']>>, c: (typeof data.customers)[number], today: string) {
    const s = minorUnits(org.functionalCurrency);
    const invoices = data.invoices.get(c.id) ?? [];
    const revenue = data.revenue.get(c.id) ?? [];
    const costs = data.costs.get(c.id) ?? [];
    const contracts = data.contracts.get(c.id) ?? [];

    const facts: InvoiceFact[] = invoices.map((i) => {
      const left = n(i.total).minus(i.applied.toString());
      return {
        issueDate: fromDbDate(i.issue_date),
        dueDate: fromDbDate(i.due_date),
        total: i.total.toFixed(),
        outstanding: left.toFixed(),
        paidOn: left.lte(0) && i.last_applied ? fromDbDate(i.last_applied) : null,
      };
    });
    const behaviour = paymentBehaviour(facts, today);

    // Months: the last twelve, oldest first.
    const months = monthRange(addDays(`${today.slice(0, 7)}-01`, -334), today).slice(-12);
    const start = months[0]!;
    const byMonth = months.map((m) => {
      const rev = revenue.filter((r) => r.month === m).reduce((t, r) => t.plus(r.revenue.toString()), new D(0));
      const cost = costs.filter((r) => r.month === m).reduce((t, r) => t.plus(r.cost.toString()), new D(0));
      return { month: m, revenue: rev.toFixed(s), cost: cost.toFixed(s), profit: rev.minus(cost).toFixed(s) };
    });
    const total = (rows: { revenue?: Prisma.Decimal; cost?: Prisma.Decimal; month: string }[], k: 'revenue' | 'cost', from?: string) =>
      rows.filter((r) => !from || r.month >= from).reduce((t, r) => t.plus((r[k] ?? 0).toString()), new D(0));
    const revAll = total(revenue, 'revenue');
    const costAll = total(costs, 'cost');
    const revT = total(revenue, 'revenue', start);
    const costT = total(costs, 'cost', start);
    const billedT = revenue.filter((r) => r.month >= start).reduce((t, r) => t.plus(r.billed.toString()), new D(0));
    const block = (r: InstanceType<typeof D>, k: InstanceType<typeof D>) => {
      const g = grossProfit(r.toFixed(), k.toFixed());
      return { revenue: r.toFixed(s), cost: k.toFixed(s), profit: new D(g.profit).toFixed(s), margin: g.margin };
    };

    const arr = contracts
      .filter((k) => k.status === 'ACTIVE')
      .reduce((t, k) => t.plus(n(k.subtotal).times(12).div(FREQUENCY_MONTHS[k.frequency as ContractFrequency])), new D(0));
    const activeContracts = contracts.filter((k) => k.status === 'ACTIVE').length;
    const trailingActive = revT.gt(0) || activeContracts > 0;
    const lifetime = lifetimeValue({
      revenueToDate: revAll.toFixed(),
      profitToDate: revAll.minus(costAll).toFixed(),
      trailingRevenue: revT.toFixed(),
      trailingProfit: revT.minus(costT).toFixed(),
      contractArr: arr.toFixed(),
      retentionRate: data.retention.rate,
      active: trailingActive,
      minorUnits: s,
    });
    // A month of billing for the suggested limit: the last twelve months' average, or the contracts' monthly value when larger.
    const monthly = D.max(billedT.div(12), arr.div(12));
    const risk = creditRisk({ behaviour, creditLimit: c.creditLimit?.toFixed() ?? null, averageMonthlyBilling: monthly.toFixed(), paymentTermsDays: c.paymentTermsDays, minorUnits: s });
    const first = facts.map((f) => f.issueDate).sort()[0] ?? null;
    return {
      contactId: c.id,
      name: c.name,
      isActive: c.isActive,
      asOf: today,
      currency: org.functionalCurrency,
      creditLimit: c.creditLimit ? c.creditLimit.toFixed(s) : null,
      paymentTermsDays: c.paymentTermsDays,
      creditHold: c.creditHold,
      creditHoldReason: c.creditHoldReason,
      creditHoldAt: c.creditHoldAt?.toISOString() ?? null,
      customerSince: first,
      invoices: facts.length,
      toDate: block(revAll, costAll),
      trailing: block(revT, costT),
      months: byMonth,
      projects: (data.projects.get(c.id) ?? []).map((p) => ({ id: p.id, code: p.code, name: p.name, isActive: p.is_active, cost: n(p.cost).toFixed(s) })),
      contracts: {
        active: activeContracts,
        paused: contracts.length - activeContracts,
        arr: arr.toFixed(s),
        mrr: arr.div(12).toFixed(s),
        items: contracts.map((k) => ({ id: k.id, number: k.number, title: k.title, status: k.status, frequency: k.frequency, perPeriod: n(k.subtotal).toFixed(s), endDate: k.endDate ? fromDbDate(k.endDate) : null })),
      },
      behaviour: { ...behaviour, open: n(behaviour.open).toFixed(s), overdue: n(behaviour.overdue).toFixed(s) },
      lifetime,
      risk,
      openInvoices: invoices
        .map((i, k) => ({ id: i.id, number: i.number, issueDate: facts[k]!.issueDate, dueDate: facts[k]!.dueDate, total: n(i.total).toFixed(s), outstanding: n(facts[k]!.outstanding).toFixed(s) }))
        .filter((i) => n(i.outstanding).gt(0))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    };
  }
}
