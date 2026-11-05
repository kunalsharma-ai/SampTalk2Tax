import { HttpStatus, Injectable } from '@nestjs/common';
import { minorUnits, SHOCK_INFO, SHOCK_KINDS, shiftYm, simulateDisaster, stressTests, TwinError, type DisasterCustomer, type DisasterInput, type DisasterShock, type DisasterSupplier } from '@talk2tax/accounting-engine';
import { Prisma, type DisasterSimulation } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIst } from '../cash-flow/cash-flow.service';
import { toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { TwinService } from '../twin/twin.service';

type Actor = { id: string };
type Months = { baselineMonths: 3 | 6 | 12; horizonMonths: number };
export type SimulationInput = Months & { name: string; description?: string | null; shocks: DisasterShock[] };

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Financial disaster simulation. Shocks are turned into digital-twin changes from the
 * organisation's own customers, suppliers and cash, and played forward from the posted books.
 * Saved simulations keep the shocks only; every run reads the books afresh. Nothing here posts,
 * pays or contacts anyone.
 */
@Injectable()
export class DisastersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly twin: TwinService,
    private readonly subledger: SubledgerService,
  ) {}

  /** The baseline, the minimum cash balance, and customers and suppliers from the books. */
  private async context(orgId: string, q: Months): Promise<DisasterInput> {
    const today = todayIst();
    const baseline = await this.twin.actuals(orgId, q.baselineMonths);
    const cashBuffer = await this.twin.buffer(orgId);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    const scale = minorUnits(org.functionalCurrency);
    const last = shiftYm(today.slice(0, 7), -1);
    const from = toDbDate(`${shiftYm(last, -(q.baselineMonths - 1))}-01`);
    const to = toDbDate(monthEnd(last));
    const per = (v: Prisma.Decimal | string) => new Prisma.Decimal(v).div(q.baselineMonths).toFixed(scale);

    // Sales to each customer: revenue lines of posted invoices less credit notes, before tax.
    const sales = await this.prisma.$queryRaw<{ contact_id: string; name: string; amount: Prisma.Decimal }[]>`
      SELECT d.contact_id, c.name, SUM(l.functional_credit - l.functional_debit) AS amount
      FROM documents d
      JOIN contacts c ON c.id = d.contact_id AND c.org_id = d.org_id
      JOIN journal_lines l ON l.entry_id = d.journal_entry_id AND l.org_id = d.org_id
      JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id AND a.type = 'REVENUE'
      WHERE d.org_id = ${orgId}::uuid AND d.kind IN ('INVOICE', 'CREDIT_NOTE') AND d.status = 'POSTED' AND d.issue_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY d.contact_id, c.name`;
    const ar = await this.subledger.ageing(org, 'SALES', today);
    const customers = new Map<string, DisasterCustomer>();
    for (const s of sales) customers.set(s.contact_id, { contactId: s.contact_id, name: s.name, monthlyRevenue: per(s.amount), balance: (0).toFixed(scale) });
    for (const r of ar.rows) {
      const balance = new Prisma.Decimal((r as unknown as Record<string, string>).balance ?? 0);
      if (balance.lte(0)) continue;
      const c = customers.get(r.contactId) ?? { contactId: r.contactId, name: r.contactName, monthlyRevenue: (0).toFixed(scale), balance: '0' };
      customers.set(r.contactId, { ...c, balance: balance.toFixed(scale) });
    }

    // Bills from each supplier, before tax: the expense and asset lines of posted bills less vendor credits.
    const spend = await this.prisma.$queryRaw<{ contact_id: string; name: string; amount: Prisma.Decimal }[]>`
      SELECT d.contact_id, c.name, SUM(l.functional_debit - l.functional_credit) AS amount
      FROM documents d
      JOIN contacts c ON c.id = d.contact_id AND c.org_id = d.org_id
      JOIN journal_lines l ON l.entry_id = d.journal_entry_id AND l.org_id = d.org_id
      JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id AND a.type = 'EXPENSE'
      WHERE d.org_id = ${orgId}::uuid AND d.kind IN ('BILL', 'VENDOR_CREDIT') AND d.status = 'POSTED' AND d.issue_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY d.contact_id, c.name`;
    const suppliers: DisasterSupplier[] = spend.filter((s) => new Prisma.Decimal(s.amount).gt(0)).map((s) => ({ contactId: s.contact_id, name: s.name, monthlySpend: per(s.amount) }));
    const byValue = (a: DisasterCustomer, b: DisasterCustomer) => new Prisma.Decimal(b.monthlyRevenue).plus(b.balance).comparedTo(new Prisma.Decimal(a.monthlyRevenue).plus(a.balance)) || a.name.localeCompare(b.name);
    return {
      baseline,
      horizonMonths: q.horizonMonths,
      cashBuffer,
      customers: [...customers.values()].sort(byValue),
      suppliers: suppliers.sort((a, b) => new Prisma.Decimal(b.monthlySpend).comparedTo(a.monthlySpend) || a.name.localeCompare(b.name)),
    };
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof TwinError) throw new DomainError('SIMULATION_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
  }

  /** Month-end cash in the baseline months, for the chart. */
  private actual(ctx: DisasterInput) {
    return ctx.baseline.months.map((m) => ({ month: m.month, cash: m.cash }));
  }

  private noBooks(ctx: DisasterInput) {
    const empty = ctx.baseline.months.every((m) => Object.entries(m).every(([k, v]) => k === 'month' || new Prisma.Decimal(v).isZero()));
    if (empty) throw new DomainError('NO_BOOKS', 'There are no posted months to simulate from yet', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /** What the builder needs: the kinds of shock, and the customers and suppliers to choose from. */
  async options(orgId: string, q: Months) {
    const ctx = await this.context(orgId, q);
    return {
      currency: ctx.baseline.currency,
      firstMonth: shiftYm(todayIst().slice(0, 7), 0),
      cashBuffer: ctx.cashBuffer,
      cash: ctx.baseline.months[ctx.baseline.months.length - 1]?.cash ?? null,
      kinds: SHOCK_KINDS.map((k) => ({ key: k, ...SHOCK_INFO[k] })),
      customers: ctx.customers,
      suppliers: ctx.suppliers,
    };
  }

  /** The standard stress tests, built from this organisation's own figures. */
  async stress(orgId: string, q: Months) {
    const ctx = await this.context(orgId, q);
    this.noBooks(ctx);
    return { currency: ctx.baseline.currency, firstMonth: shiftYm(todayIst().slice(0, 7), 0), ...q, ...this.wrap(() => stressTests(ctx)) };
  }

  /** Runs shocks without saving them. */
  async simulate(orgId: string, q: Months & { shocks: DisasterShock[] }) {
    const ctx = await this.context(orgId, q);
    this.noBooks(ctx);
    return { currency: ctx.baseline.currency, actual: this.actual(ctx), ...this.wrap(() => simulateDisaster({ ...ctx, shocks: q.shocks })) };
  }

  // ---- saved simulations

  private view(s: DisasterSimulation) {
    return {
      id: s.id,
      number: `DS-${String(s.number).padStart(4, '0')}`,
      name: s.name,
      description: s.description,
      baselineMonths: s.baselineMonths as 3 | 6 | 12,
      horizonMonths: s.horizonMonths,
      shocks: s.shocks as unknown as DisasterShock[],
      createdById: s.createdById,
      updatedById: s.updatedById,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private async find(orgId: string, id: string) {
    const s = await this.prisma.disasterSimulation.findFirst({ where: { id, orgId } });
    if (!s) throw new DomainError('NOT_FOUND', 'Disaster simulation not found', HttpStatus.NOT_FOUND);
    return s;
  }

  async list(orgId: string) {
    const rows = await this.prisma.disasterSimulation.findMany({ where: { orgId }, orderBy: { number: 'desc' } });
    const contexts = new Map<string, DisasterInput>();
    const items = [];
    for (const r of rows) {
      const key = `${r.baselineMonths}-${r.horizonMonths}`;
      if (!contexts.has(key)) contexts.set(key, await this.context(orgId, { baselineMonths: r.baselineMonths as 3 | 6 | 12, horizonMonths: r.horizonMonths }));
      let impact = null;
      try {
        impact = simulateDisaster({ ...contexts.get(key)!, shocks: r.shocks as unknown as DisasterShock[] }).impact;
      } catch {
        // A customer or supplier may have left the books; the simulation's own page explains.
      }
      items.push({ ...this.view(r), verdict: impact?.verdict ?? null, lowestCash: impact?.lowestCash ?? null });
    }
    return { items };
  }

  async get(orgId: string, id: string) {
    const s = await this.find(orgId, id);
    const v = this.view(s);
    const ctx = await this.context(orgId, v);
    let result = null;
    let problem: { message: string; issues: string[] } | null = null;
    try {
      this.noBooks(ctx);
      result = this.wrap(() => simulateDisaster({ ...ctx, shocks: v.shocks }));
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      problem = { message: e.message, issues: ((e.details as { issues?: string[] } | undefined)?.issues ?? []) };
    }
    return { ...v, currency: ctx.baseline.currency, actual: this.actual(ctx), result, problem };
  }

  private async check(orgId: string, input: SimulationInput, exceptId?: string) {
    const clash = await this.prisma.disasterSimulation.findFirst({ where: { orgId, name: input.name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new DomainError('DUPLICATE', 'A disaster simulation with that name already exists', HttpStatus.CONFLICT);
    const ctx = await this.context(orgId, input);
    this.noBooks(ctx);
    this.wrap(() => simulateDisaster({ ...ctx, shocks: input.shocks }));
  }

  async create(orgId: string, actor: Actor, input: SimulationInput) {
    await this.check(orgId, input);
    const s = await this.prisma.$transaction(async (tx) => {
      const top = await tx.disasterSimulation.aggregate({ where: { orgId }, _max: { number: true } });
      const s = await tx.disasterSimulation.create({
        data: { orgId, number: (top._max.number ?? 0) + 1, name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, shocks: input.shocks as unknown as Prisma.InputJsonValue, createdById: actor.id, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'disaster_simulation.created', entityType: 'disaster_simulation', entityId: s.id, data: { name: s.name, shocks: input.shocks.map((x) => x.kind) } });
      return s;
    });
    return this.get(orgId, s.id);
  }

  async update(orgId: string, actor: Actor, id: string, input: SimulationInput) {
    const before = await this.find(orgId, id);
    await this.check(orgId, input, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.disasterSimulation.update({ where: { id }, data: { name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, shocks: input.shocks as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'disaster_simulation.updated', entityType: 'disaster_simulation', entityId: id, data: { before: { name: before.name, baselineMonths: before.baselineMonths, horizonMonths: before.horizonMonths, shocks: before.shocks }, after: { name: input.name, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, shocks: input.shocks } } });
    });
    return this.get(orgId, id);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    const s = await this.find(orgId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.disasterSimulation.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'disaster_simulation.deleted', entityType: 'disaster_simulation', entityId: id, data: { name: s.name, shocks: s.shocks } });
    });
  }

  /** Saves the shocks as a digital-twin scenario, so they can go through the war room. */
  async toScenario(orgId: string, actor: Actor, id: string) {
    const g = await this.get(orgId, id);
    if (!g.result) throw new DomainError('SIMULATION_INVALID', g.problem?.message ?? 'The simulation cannot be run', HttpStatus.UNPROCESSABLE_ENTITY, { issues: g.problem?.issues ?? [] });
    const drivers = g.result.shocks.flatMap((s) => s.drivers);
    const name = `${g.name} (${g.number})`.slice(0, 120);
    const description = [`From disaster simulation ${g.number}.`, ...g.result.shocks.map((s) => `${s.title}: ${s.explanation.join(' ')}`)].join('\n').slice(0, 1000);
    const scenario = await this.twin.create(orgId, actor, { name, description, baselineMonths: g.baselineMonths, horizonMonths: g.horizonMonths, drivers });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId: actor.id, action: 'disaster_simulation.scenario_created', entityType: 'disaster_simulation', entityId: id, data: { scenarioId: scenario.id } }));
    return { scenarioId: scenario.id };
  }
}
