import { MovedTables } from '../db/moved-table';
import { CONTACTS } from '../db/collections/sales';
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
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { byCode, roundPg, withOpen } from '../db/subledger-queries';

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
    private readonly moved: MovedTables,
    private readonly store: DocumentStoreService,
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
        await this.moved.update(tx, CONTACTS, org.id, contactId, { creditHold: true, creditHoldReason: reason, creditHoldAt: new Date(), creditHoldById: actor.id, updatedAt: new Date() });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.credit_hold_set', entityType: 'contact', entityId: contactId, data: { reason } });
      } else {
        if (!c.creditHold) throw new DomainError('NOT_ON_HOLD', `${c.name} is not on credit hold`, HttpStatus.CONFLICT);
        await this.moved.update(tx, CONTACTS, org.id, contactId, { creditHold: false, creditHoldReason: null, creditHoldAt: null, creditHoldById: null, updatedAt: new Date() });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.credit_hold_lifted', entityType: 'contact', entityId: contactId, data: { reason, wasReason: c.creditHoldReason } });
      }
      return { contactId, creditHold: body.hold, creditHoldReason: body.hold ? reason : null };
    });
  }

  // ------------------------------------------------------------------ data

  private async gather(org: InsightOrg, today: string, contactId?: string) {
    const only = contactId ? { contactId } : {};
    const asOf = toDbDate(today);
    const month = (d: Date) => fromDbDate(d).slice(0, 7);
    const [customers, contracts, accounts, docs, projectRows] = await Promise.all([
      this.prisma.contact.findMany({
        where: { orgId: org.id, isCustomer: true, ...(contactId ? { id: contactId } : {}) },
        select: { id: true, name: true, creditLimit: true, paymentTermsDays: true, creditHold: true, creditHoldReason: true, creditHoldAt: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.salesContract.findMany({
        where: { orgId: org.id, status: { in: ['ACTIVE', 'PAUSED'] }, ...(contactId ? { contactId } : {}) },
        select: { id: true, contactId: true, number: true, title: true, status: true, frequency: true, subtotal: true, endDate: true },
        orderBy: { number: 'asc' },
      }),
      this.prisma.account.findMany({ where: { orgId: org.id, type: { in: ['REVENUE', 'EXPENSE'] } }, select: { id: true, type: true } }),
      this.prisma.document.findMany({
        where: { orgId: org.id, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: 'POSTED', issueDate: { lte: asOf }, ...only },
        select: { id: true, kind: true, contactId: true, number: true, issueDate: true, dueDate: true, total: true, exchangeRate: true, lines: { select: { accountId: true, netAmount: true } } },
      }),
      this.prisma.dimensionValue.findMany({ where: { orgId: org.id, type: 'PROJECT', contactId: { not: null }, ...only }, select: { id: true, contactId: true, code: true, name: true, isActive: true } }),
    ]);
    const revenueAccounts = new Set(accounts.filter((a) => a.type === 'REVENUE').map((a) => a.id));
    const expenseAccounts = accounts.filter((a) => a.type === 'EXPENSE').map((a) => a.id);

    // Posted invoices with what has been applied to them up to today, and the day the last of it was applied.
    const invoices = (await withOpen(this.prisma, org.id, docs.filter((d) => d.kind === 'INVOICE'), asOf)).map((x) => ({
      id: x.id,
      contact_id: x.contactId,
      number: x.number!,
      issue_date: x.issueDate,
      due_date: x.dueDate,
      total: roundPg(x.total.times(x.exchangeRate), 2),
      applied: roundPg(x.allocated.times(x.exchangeRate), 2),
      last_applied: x.lastAllocated,
    }));

    // Revenue by month: income lines on posted invoices, less posted credit notes.
    const rev = new Map<string, { contact_id: string; month: string; revenue: Prisma.Decimal; billed: Prisma.Decimal }>();
    for (const d of docs) {
      const k = `${d.contactId}|${month(d.issueDate)}`;
      const r = rev.get(k) ?? { contact_id: d.contactId, month: month(d.issueDate), revenue: new Prisma.Decimal(0), billed: new Prisma.Decimal(0) };
      let any = false;
      for (const l of d.lines) {
        if (!revenueAccounts.has(l.accountId)) continue;
        any = true;
        const v = l.netAmount.times(d.exchangeRate);
        r.revenue = d.kind === 'INVOICE' ? r.revenue.plus(v) : r.revenue.minus(v);
        if (d.kind === 'INVOICE') r.billed = r.billed.plus(v);
      }
      if (any) rev.set(k, r);
    }
    const revenue = [...rev.values()].map((r) => ({ ...r, revenue: roundPg(r.revenue, 2), billed: roundPg(r.billed, 2) }));

    // Direct costs by month: expenses posted to the customer's projects.
    const projectContact = new Map(projectRows.map((x) => [x.id, x.contactId!]));
    const sums =
      projectRows.length && expenseAccounts.length
        ? await lineSums(this.store, org.id, {
            entry: postedBetween(null, asOf),
            line: { projectId: { $in: projectRows.map((x) => x.id) }, accountId: { $in: expenseAccounts } },
            by: { projectId: 'lines.projectId', month: { $dateToString: { date: '$date', format: '%Y-%m' } } },
          })
        : [];
    const costMap = new Map<string, { contact_id: string; month: string; cost: Prisma.Decimal }>();
    const perProject = new Map<string, Prisma.Decimal>();
    for (const x of sums) {
      const net = new Prisma.Decimal(x.debit.minus(x.credit).toFixed());
      const pid = x.key.projectId as string;
      const c = projectContact.get(pid)!;
      const k = `${c}|${x.key.month as string}`;
      costMap.set(k, { contact_id: c, month: x.key.month as string, cost: (costMap.get(k)?.cost ?? new Prisma.Decimal(0)).plus(net) });
      perProject.set(pid, (perProject.get(pid) ?? new Prisma.Decimal(0)).plus(net));
    }
    const costs = [...costMap.values()];
    const projects = projectRows
      .map((x) => ({ id: x.id, contact_id: x.contactId!, code: x.code, name: x.name, is_active: x.isActive, cost: perProject.get(x.id) ?? new Prisma.Decimal(0) }))
      .sort(byCode);

    // Customers billed in the twelve months before last, and in the last twelve months (for retention),
    // across every customer even when one is asked for.
    const yearAgo = toDbDate(addDays(today, -365));
    const twoYearsAgo = toDbDate(addDays(today, -730));
    const billed = await this.prisma.document.findMany({ where: { orgId: org.id, kind: 'INVOICE', status: 'POSTED', issueDate: { gt: twoYearsAgo, lte: asOf } }, select: { contactId: true, issueDate: true } });
    const windows = billed.map((d) => ({ contact_id: d.contactId, w: d.issueDate > yearAgo ? 1 : 0 }));
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
