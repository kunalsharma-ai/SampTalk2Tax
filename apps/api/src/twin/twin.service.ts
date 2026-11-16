import { HttpStatus, Injectable } from '@nestjs/common';
import { minorUnits, runTwin, TWIN_TEMPLATES, TwinError, type TwinActualMonth, type TwinDriverWithMeta, type TwinResult } from '@talk2tax/accounting-engine';
import { Prisma, type TwinScenario } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIst } from '../cash-flow/cash-flow.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { KpisService } from '../kpis/kpis.service';

type Actor = { id: string };

export interface ScenarioInput {
  name: string;
  description?: string | null;
  baselineMonths: 3 | 6 | 12;
  horizonMonths: number;
  drivers: TwinDriverWithMeta[];
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * The financial digital twin. Scenarios are stored as their drivers only; every run reads the
 * baseline afresh from the posted books (through the same month figures as the KPIs) and
 * computes the projection in the engine. Nothing is ever written to the ledger.
 */
@Injectable()
export class TwinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kpis: KpisService,
  ) {}

  /** The last `count` complete months of actual figures. */
  async actuals(orgId: string, count: number) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    const last = shiftMonth(todayIst().slice(0, 7), -1);
    const figures = await this.kpis.monthFigures(orgId, last, monthEnd(last), count);
    const months: TwinActualMonth[] = figures.map((m) => ({
      month: m.month,
      revenue: m.operatingRevenue.toFixed(),
      otherIncome: m.otherIncome.toFixed(),
      costOfSales: m.costOfSales.toFixed(),
      payroll: m.payroll.toFixed(),
      otherOperating: m.operatingExpenses.minus(m.payroll).minus(m.depreciation).toFixed(),
      depreciation: m.depreciation.toFixed(),
      interest: m.interest.toFixed(),
      incomeTax: m.incomeTax.toFixed(),
      otherExpenses: m.otherExpenses.toFixed(),
      cash: m.cash.toFixed(),
      receivables: m.receivables.toFixed(),
      payables: m.payables.toFixed(),
    }));
    return { currency: org.functionalCurrency, scale: minorUnits(org.functionalCurrency), months };
  }

  private async buffer(orgId: string) {
    const s = await this.prisma.cashFlowSettings.findUnique({ where: { orgId } });
    return s?.minimumBalance.toFixed() ?? null;
  }

  /** Runs drivers against the current baseline, without saving anything. */
  async simulate(orgId: string, input: Pick<ScenarioInput, 'baselineMonths' | 'horizonMonths' | 'drivers'>) {
    const a = await this.actuals(orgId, input.baselineMonths);
    let result: TwinResult;
    try {
      result = runTwin({ baseline: a, drivers: input.drivers, horizonMonths: input.horizonMonths, cashBuffer: await this.buffer(orgId) });
    } catch (e) {
      if (e instanceof TwinError) throw new DomainError('SCENARIO_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
    return { currency: a.currency, actualMonths: a.months, ...result };
  }

  /** The same actual months and a run with no changes, for comparing against. */
  async baseline(orgId: string, q: { baselineMonths: 3 | 6 | 12; horizonMonths: number }) {
    return this.simulate(orgId, { ...q, drivers: [] });
  }

  templates() {
    return TWIN_TEMPLATES;
  }

  private view(s: TwinScenario) {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      baselineMonths: s.baselineMonths as 3 | 6 | 12,
      horizonMonths: s.horizonMonths,
      drivers: s.drivers as unknown as TwinDriverWithMeta[],
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private async find(orgId: string, id: string) {
    const s = await this.prisma.twinScenario.findFirst({ where: { id, orgId } });
    if (!s) throw new DomainError('NOT_FOUND', 'Scenario not found', HttpStatus.NOT_FOUND);
    return s;
  }

  async list(orgId: string) {
    const rows = await this.prisma.twinScenario.findMany({ where: { orgId }, orderBy: { updatedAt: 'desc' } });
    return { items: rows.map((s) => this.view(s)) };
  }

  /** A saved scenario with a fresh run against today's actuals and the no-change run beside it. */
  async get(orgId: string, id: string) {
    const s = this.view(await this.find(orgId, id));
    const [run, base] = await Promise.all([this.simulate(orgId, s), this.baseline(orgId, s)]);
    return { scenario: s, result: run, baseline: { projection: base.projection } };
  }

  private async checkName(orgId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.twinScenario.findFirst({ where: { orgId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new DomainError('DUPLICATE', 'A scenario with that name already exists', HttpStatus.CONFLICT);
  }

  async create(orgId: string, actor: Actor, input: ScenarioInput) {
    await this.simulate(orgId, input); // refuses invalid drivers with the engine's own messages
    await this.checkName(orgId, input.name);
    const s = await this.prisma.$transaction(async (tx) => {
      const s = await tx.twinScenario.create({
        data: { orgId, name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, drivers: input.drivers as unknown as Prisma.InputJsonValue, createdById: actor.id, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.created', entityType: 'twin_scenario', entityId: s.id, data: { name: input.name, drivers: input.drivers.length } });
      return s;
    });
    return this.view(s);
  }

  async update(orgId: string, actor: Actor, id: string, input: ScenarioInput) {
    const before = await this.find(orgId, id);
    await this.simulate(orgId, input);
    await this.checkName(orgId, input.name, id);
    const s = await this.prisma.$transaction(async (tx) => {
      const s = await tx.twinScenario.update({
        where: { id },
        data: { name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, drivers: input.drivers as unknown as Prisma.InputJsonValue, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.updated', entityType: 'twin_scenario', entityId: id, data: { name: input.name, before: { drivers: before.drivers, horizonMonths: before.horizonMonths, baselineMonths: before.baselineMonths }, drivers: input.drivers.length } });
      return s;
    });
    return this.view(s);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    const s = await this.find(orgId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.twinScenario.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.deleted', entityType: 'twin_scenario', entityId: id, data: { name: s.name } });
    });
    return { deleted: true };
  }

  /**
   * Side-by-side key figures for up to five saved scenarios and the no-change baseline, over the
   * same horizon and baseline months (the longest and largest of those chosen).
   */
  async compare(orgId: string, ids: string[]) {
    if (!ids.length || ids.length > 5) throw new DomainError('VALIDATION_FAILED', 'Choose one to five scenarios to compare', HttpStatus.BAD_REQUEST);
    const scenarios = await Promise.all([...new Set(ids)].map((id) => this.find(orgId, id).then((s) => this.view(s))));
    const horizonMonths = Math.max(...scenarios.map((s) => s.horizonMonths));
    const baselineMonths = Math.max(...scenarios.map((s) => s.baselineMonths)) as 3 | 6 | 12;
    const base = await this.baseline(orgId, { baselineMonths, horizonMonths });
    const runs = await Promise.all(scenarios.map((s) => this.simulate(orgId, { baselineMonths, horizonMonths, drivers: s.drivers })));
    const summary = (name: string, id: string | null, r: Awaited<ReturnType<TwinService['simulate']>>) => ({
      id,
      name,
      revenue: r.projection.totals.revenue,
      netProfit: r.projection.totals.netProfit,
      netMarginPercent: r.projection.totals.netMarginPercent,
      closingCash: r.projection.closingCash,
      minimumCash: r.projection.minimumCash,
      cashNegativeFrom: r.projection.cashNegativeFrom,
      cashRequired: r.projection.cashRequired,
      risks: r.risks.filter((x) => x.level === 'HIGH').length,
      cash: r.projection.months.map((m) => m.closingCash),
    });
    return {
      currency: base.currency,
      horizonMonths,
      baselineMonths,
      months: base.projection.months.map((m) => m.month),
      rows: [summary('No change (baseline)', null, base), ...scenarios.map((s, i) => summary(s.name, s.id, runs[i]!))],
    };
  }
}
