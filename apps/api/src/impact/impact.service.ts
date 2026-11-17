import { HttpStatus, Injectable } from '@nestjs/common';
import { assessImpact, costOfSalesShare, IMPACT_AREA_LABEL, IMPACT_AREAS, IMPACT_LEVERS, LEVER_INFO, shiftYm, TwinError, type ImpactChange, type ImpactInput } from '@talk2tax/accounting-engine';
import { Prisma, type ImpactAssessment } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIst } from '../cash-flow/cash-flow.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { DisastersService } from '../disasters/disasters.service';
import { TwinService } from '../twin/twin.service';

type Actor = { id: string };
type Months = { baselineMonths: 3 | 6 | 12; horizonMonths: number };
export type AssessmentInput = Months & { name: string; description?: string | null; changes: ImpactChange[] };

/**
 * Business impact engine. Sales, HR, procurement and operations changes are turned into
 * digital-twin changes from the organisation's own figures and played forward from the posted
 * books against carrying on as is. Saved assessments keep the changes only; every view reads the
 * books afresh. Nothing here posts, pays or commits anyone.
 */
@Injectable()
export class ImpactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly twin: TwinService,
    private readonly disasters: DisastersService,
  ) {}

  /** The baseline, the minimum cash balance, and customers and suppliers from the books. */
  private async context(orgId: string, q: Months): Promise<ImpactInput> {
    const d = await this.disasters.context(orgId, q);
    return { baseline: d.baseline, horizonMonths: d.horizonMonths, cashBuffer: d.cashBuffer, customers: d.customers.filter((c) => new Prisma.Decimal(c.monthlyRevenue).gt(0)).map((c) => ({ contactId: c.contactId, name: c.name, monthlyRevenue: c.monthlyRevenue })), suppliers: d.suppliers };
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof TwinError) throw new DomainError('ASSESSMENT_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
  }

  /** Month-end cash in the baseline months, for the chart. */
  private actual(ctx: ImpactInput) {
    return ctx.baseline.months.map((m) => ({ month: m.month, cash: m.cash }));
  }

  private noBooks(ctx: ImpactInput) {
    const empty = ctx.baseline.months.every((m) => Object.entries(m).every(([k, v]) => k === 'month' || new Prisma.Decimal(v).isZero()));
    if (empty) throw new DomainError('NO_BOOKS', 'There are no posted months to assess from yet', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /** What the builder needs: the levers by business area, and the customers and suppliers to choose from. */
  async options(orgId: string, q: Months) {
    const ctx = await this.context(orgId, q);
    const n = ctx.baseline.months.length || 1;
    const avg = (k: 'revenue' | 'costOfSales' | 'payroll' | 'otherOperating') => ctx.baseline.months.reduce((a, m) => a.plus(m[k]), new Prisma.Decimal(0)).div(n).toFixed(ctx.baseline.scale);
    return {
      currency: ctx.baseline.currency,
      firstMonth: shiftYm(todayIst().slice(0, 7), 0),
      areas: IMPACT_AREAS.map((a) => ({ key: a, label: IMPACT_AREA_LABEL[a] })),
      levers: IMPACT_LEVERS.map((k) => ({ key: k, ...LEVER_INFO[k] })),
      monthly: { revenue: avg('revenue'), costOfSales: avg('costOfSales'), payroll: avg('payroll'), otherOperating: avg('otherOperating') },
      costOfSalesPercent: costOfSalesShare(ctx.baseline).toFixed(2),
      customers: ctx.customers,
      suppliers: ctx.suppliers,
    };
  }

  /** Runs changes without saving them. */
  async assess(orgId: string, q: Months & { changes: ImpactChange[] }) {
    const ctx = await this.context(orgId, q);
    this.noBooks(ctx);
    return { currency: ctx.baseline.currency, actual: this.actual(ctx), ...this.wrap(() => assessImpact({ ...ctx, changes: q.changes })) };
  }

  // ---- saved assessments

  private view(s: ImpactAssessment) {
    return {
      id: s.id,
      number: `BI-${String(s.number).padStart(4, '0')}`,
      name: s.name,
      description: s.description,
      baselineMonths: s.baselineMonths as 3 | 6 | 12,
      horizonMonths: s.horizonMonths,
      changes: s.changes as unknown as ImpactChange[],
      createdById: s.createdById,
      updatedById: s.updatedById,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private async find(orgId: string, id: string) {
    const s = await this.prisma.impactAssessment.findFirst({ where: { id, orgId } });
    if (!s) throw new DomainError('NOT_FOUND', 'Impact assessment not found', HttpStatus.NOT_FOUND);
    return s;
  }

  async list(orgId: string) {
    const rows = await this.prisma.impactAssessment.findMany({ where: { orgId }, orderBy: { number: 'desc' } });
    const contexts = new Map<string, ImpactInput>();
    const items = [];
    for (const r of rows) {
      const key = `${r.baselineMonths}-${r.horizonMonths}`;
      if (!contexts.has(key)) contexts.set(key, await this.context(orgId, { baselineMonths: r.baselineMonths as 3 | 6 | 12, horizonMonths: r.horizonMonths }));
      let change = null;
      try {
        change = assessImpact({ ...contexts.get(key)!, changes: r.changes as unknown as ImpactChange[] }).change;
      } catch {
        // A customer or supplier may have left the books; the assessment's own page explains.
      }
      const changes = r.changes as unknown as ImpactChange[];
      items.push({ ...this.view(r), areas: [...new Set(changes.map((c) => LEVER_INFO[c.lever]?.area).filter(Boolean))], netProfitChange: change?.netProfit ?? null, closingCashChange: change?.closingCash ?? null });
    }
    return { items };
  }

  async get(orgId: string, id: string) {
    const v = this.view(await this.find(orgId, id));
    const ctx = await this.context(orgId, v);
    let result = null;
    let problem: { message: string; issues: string[] } | null = null;
    try {
      this.noBooks(ctx);
      result = this.wrap(() => assessImpact({ ...ctx, changes: v.changes }));
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      problem = { message: e.message, issues: (e.details as { issues?: string[] } | undefined)?.issues ?? [] };
    }
    return { ...v, currency: ctx.baseline.currency, actual: this.actual(ctx), result, problem };
  }

  private async check(orgId: string, input: AssessmentInput, exceptId?: string) {
    const clash = await this.prisma.impactAssessment.findFirst({ where: { orgId, name: input.name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new DomainError('DUPLICATE', 'An impact assessment with that name already exists', HttpStatus.CONFLICT);
    const ctx = await this.context(orgId, input);
    this.noBooks(ctx);
    this.wrap(() => assessImpact({ ...ctx, changes: input.changes }));
  }

  async create(orgId: string, actor: Actor, input: AssessmentInput) {
    await this.check(orgId, input);
    const s = await this.prisma.$transaction(async (tx) => {
      const top = await tx.impactAssessment.aggregate({ where: { orgId }, _max: { number: true } });
      const s = await tx.impactAssessment.create({
        data: { orgId, number: (top._max.number ?? 0) + 1, name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, changes: input.changes as unknown as Prisma.InputJsonValue, createdById: actor.id, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'impact_assessment.created', entityType: 'impact_assessment', entityId: s.id, data: { name: s.name, changes: input.changes.map((x) => x.lever) } });
      return s;
    });
    return this.get(orgId, s.id);
  }

  async update(orgId: string, actor: Actor, id: string, input: AssessmentInput) {
    const before = await this.find(orgId, id);
    await this.check(orgId, input, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.impactAssessment.update({ where: { id }, data: { name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, changes: input.changes as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'impact_assessment.updated', entityType: 'impact_assessment', entityId: id, data: { before: { name: before.name, baselineMonths: before.baselineMonths, horizonMonths: before.horizonMonths, changes: before.changes }, after: { name: input.name, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, changes: input.changes } } });
    });
    return this.get(orgId, id);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    const s = await this.find(orgId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.impactAssessment.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'impact_assessment.deleted', entityType: 'impact_assessment', entityId: id, data: { name: s.name, changes: s.changes } });
    });
  }

  /** Saves the changes as a digital-twin scenario, so they can go through the war room. */
  async toScenario(orgId: string, actor: Actor, id: string) {
    const g = await this.get(orgId, id);
    if (!g.result) throw new DomainError('ASSESSMENT_INVALID', g.problem?.message ?? 'The assessment cannot be run', HttpStatus.UNPROCESSABLE_ENTITY, { issues: g.problem?.issues ?? [] });
    const drivers = g.result.changes.flatMap((c) => c.drivers);
    const name = `${g.name} (${g.number})`.slice(0, 120);
    const description = [`From business impact assessment ${g.number}.`, ...g.result.changes.map((c) => `${c.title}: ${c.explanation.join(' ')}`)].join('\n').slice(0, 1000);
    const scenario = await this.twin.create(orgId, actor, { name, description, baselineMonths: g.baselineMonths, horizonMonths: g.horizonMonths, drivers });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId: actor.id, action: 'impact_assessment.scenario_created', entityType: 'impact_assessment', entityId: id, data: { scenarioId: scenario.id } }));
    return { scenarioId: scenario.id };
  }
}
