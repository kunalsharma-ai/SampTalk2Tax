import { HttpStatus, Injectable } from '@nestjs/common';
import {
  baselineMonthFor,
  checkOutcome,
  computeKpis,
  DECISION_CATEGORIES,
  DECISION_VERDICTS,
  evaluateOutcome,
  formatAmountText,
  KPI_DEFINITIONS,
  type DecisionVerdict,
  type ExpectedOutcome,
  type KpiKey,
  minorUnits,
  monthIsOver,
  type OutcomeResult,
  searchTerms,
  suggestVerdict,
} from '@talk2tax/accounting-engine';
import { Prisma, type Decision } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, istDate, todayIso, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { KpisService } from '../kpis/kpis.service';
import { TwinService } from '../twin/twin.service';

type Actor = { id: string };
export type DecisionCategoryKey = (typeof DECISION_CATEGORIES)[number]['key'];
export interface AssumptionInput { text: string }
export interface OutcomeInput { kpi: string; comparator: 'AT_LEAST' | 'AT_MOST'; target: string; measureMonth: string }
export interface DecisionInput {
  title: string;
  decision: string;
  context?: string | null;
  category: DecisionCategoryKey;
  tags?: string[];
  decidedOn: string;
  decidedBy?: string | null;
  reviewDue?: string | null;
  assumptions: AssumptionInput[];
  outcomes: OutcomeInput[];
  sourceType?: 'SCENARIO' | 'RECOVERY_PLAN' | null;
  sourceId?: string | null;
}
export interface ReviewInput {
  verdict: DecisionVerdict;
  outcomeNotes?: string | null;
  lessons: string;
  assumptions: { held: boolean | null; note?: string | null }[];
}

interface StoredAssumption { text: string; held: boolean | null; note: string | null }
interface StoredOutcome extends ExpectedOutcome { baselineMonth: string; baseline: string | null; actual?: string | null; status?: OutcomeResult['status'] }

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const dm = (n: number) => `DM-${String(n).padStart(4, '0')}`;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Decision memory: approved management decisions with their assumptions and the outcomes they
 * were expected to produce, measured later from the posted books, and what was learned. Reading
 * needs reports.read; recording, editing, reviewing and withdrawing need decisions.manage.
 * Reviewed and withdrawn decisions are kept as they were (a database trigger refuses changes).
 */
@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kpis: KpisService,
    private readonly twin: TwinService,
  ) {}

  private async org(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    return { currency: o.functionalCurrency, scale: minorUnits(o.functionalCurrency) };
  }

  /** KPI values for months, from the posted books; one read per month, shared across calls. */
  private kpiReader(orgId: string, scale: number) {
    const cache = new Map<string, Promise<Map<KpiKey, string | null>>>();
    return (month: string): Promise<Map<KpiKey, string | null>> => {
      if (!cache.has(month)) {
        cache.set(
          month,
          this.kpis.monthFigures(orgId, month, monthEnd(month), 3).then((months) => new Map(computeKpis(months, scale).map((k) => [k.key, k.value]))),
        );
      }
      return cache.get(month)!;
    };
  }

  private async names(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
    return Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<string, string>;
  }

  private async find(orgId: string, id: string) {
    const d = await this.prisma.decision.findFirst({ where: { orgId, id } });
    if (!d) throw new DomainError('NOT_FOUND', 'Decision not found', HttpStatus.NOT_FOUND);
    return d;
  }

  private checkInput(input: DecisionInput) {
    if (input.decidedOn > todayIso()) throw new DomainError('INVALID_DATE', 'A decision cannot be dated in the future');
    if (input.reviewDue && input.reviewDue < input.decidedOn) throw new DomainError('INVALID_DATE', 'The review date cannot be before the decision');
    input.outcomes.forEach((o, i) => {
      const err = checkOutcome(o, input.decidedOn);
      if (err) throw new DomainError('INVALID_OUTCOME', `Expected outcome ${i + 1}: ${err}`);
    });
    const keys = input.outcomes.map((o) => `${o.kpi}|${o.measureMonth}`);
    if (new Set(keys).size !== keys.length) throw new DomainError('INVALID_OUTCOME', 'Each measure can be expected only once for the same month');
  }

  /** Outcomes as stored: each with the KPI's value in the month before the decision. */
  private async storeOutcomes(orgId: string, decidedOn: string, outcomes: OutcomeInput[], previous: StoredOutcome[] = []): Promise<StoredOutcome[]> {
    const { scale } = await this.org(orgId);
    const read = this.kpiReader(orgId, scale);
    const baselineMonth = baselineMonthFor(decidedOn);
    return Promise.all(
      outcomes.map(async (o) => {
        const same = previous.find((p) => p.kpi === o.kpi && p.baselineMonth === baselineMonth);
        const baseline = same ? same.baseline : ((await read(baselineMonth)).get(o.kpi as KpiKey) ?? null);
        return { kpi: o.kpi as KpiKey, comparator: o.comparator, target: o.target, measureMonth: o.measureMonth, baselineMonth, baseline };
      }),
    );
  }

  private async sourceView(orgId: string, d: Pick<Decision, 'sourceType' | 'sourceId'>) {
    if (!d.sourceType || !d.sourceId) return null;
    if (d.sourceType === 'SCENARIO') {
      const s = await this.prisma.twinScenario.findFirst({ where: { orgId, id: d.sourceId }, select: { id: true, name: true } });
      return { type: 'SCENARIO', id: d.sourceId, label: s ? `Scenario ${s.name}` : 'Scenario (deleted)', path: s ? `/planning/twin/${s.id}` : null };
    }
    const p = await this.prisma.recoveryPlan.findFirst({ where: { orgId, id: d.sourceId }, select: { id: true, name: true } });
    return { type: 'RECOVERY_PLAN', id: d.sourceId, label: p ? `Recovery plan ${p.name}` : 'Recovery plan (deleted)', path: p ? `/planning/recovery/${p.id}` : null };
  }

  /** Outcomes with what happened: frozen at review, otherwise measured now from the books. */
  private async outcomesView(orgId: string, d: Decision, read: (m: string) => Promise<Map<KpiKey, string | null>>, currency: string) {
    const today = todayIso();
    const money = (v: string) => formatAmountText(v, currency);
    return Promise.all(
      (d.outcomes as unknown as StoredOutcome[]).map(async (o) => {
        const def = KPI_DEFINITIONS.find((k) => k.key === o.kpi)!;
        const frozen = d.status === 'REVIEWED' && o.actual !== undefined;
        const actual = frozen ? (o.actual ?? null) : monthIsOver(o.measureMonth, today) ? ((await read(o.measureMonth)).get(o.kpi) ?? null) : null;
        const r = evaluateOutcome(o, actual, o.baseline, frozen && o.status === 'NOT_DUE' ? `${o.measureMonth}-01` : today, money);
        return { kpi: o.kpi, label: def.label, unit: def.unit, better: def.better, comparator: o.comparator, target: o.target, measureMonth: o.measureMonth, baselineMonth: o.baselineMonth, baseline: o.baseline, actual, frozen, ...r };
      }),
    );
  }

  private async view(orgId: string, d: Decision, read?: (m: string) => Promise<Map<KpiKey, string | null>>) {
    const o = await this.org(orgId);
    const outcomes = await this.outcomesView(orgId, d, read ?? this.kpiReader(orgId, o.scale), o.currency);
    const today = todayIso();
    const reviewDue = d.reviewDue ? fromDbDate(d.reviewDue) : null;
    return {
      id: d.id,
      number: dm(d.number),
      title: d.title,
      decision: d.decision,
      context: d.context,
      category: d.category,
      tags: d.tags,
      decidedOn: fromDbDate(d.decidedOn),
      decidedBy: d.decidedBy,
      reviewDue,
      reviewOverdue: d.status === 'ACTIVE' && !!reviewDue && reviewDue <= today,
      assumptions: d.assumptions as unknown as StoredAssumption[],
      outcomes,
      suggestedVerdict: suggestVerdict(outcomes),
      status: d.status,
      verdict: d.verdict,
      outcomeNotes: d.outcomeNotes,
      lessons: d.lessons,
      reviewedById: d.reviewedById,
      reviewedAt: d.reviewedAt?.toISOString() ?? null,
      withdrawnReason: d.withdrawnReason,
      withdrawnById: d.withdrawnById,
      withdrawnAt: d.withdrawnAt?.toISOString() ?? null,
      createdById: d.createdById,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      currency: o.currency,
    };
  }

  meta() {
    return {
      categories: DECISION_CATEGORIES,
      verdicts: DECISION_VERDICTS,
      measures: KPI_DEFINITIONS.map((k) => ({ key: k.key, label: k.label, unit: k.unit, better: k.better, formula: k.formula })),
    };
  }

  /** Searchable history: every word must appear somewhere in the decision, its assumptions or its lessons. */
  async list(orgId: string, q: { q?: string; category?: string; status?: string; verdict?: string }) {
    const terms = searchTerms(q.q ?? '');
    let ids: string[] | undefined;
    if (terms.length) {
      const patterns = terms.map((t) => `%${escapeLike(t)}%`);
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM decisions WHERE org_id = ${orgId}::uuid
          AND lower(concat_ws(' ', 'dm-' || lpad(number::text, 4, '0'), title, decision, context, decided_by, outcome_notes, lessons, withdrawn_reason, array_to_string(tags, ' '), assumptions::text)) LIKE ALL(${patterns}::text[])`;
      ids = rows.map((r) => r.id);
    }
    const rows = await this.prisma.decision.findMany({
      where: {
        orgId,
        ...(ids ? { id: { in: ids } } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.status ? { status: q.status as Decision['status'] } : {}),
        ...(q.verdict ? { verdict: q.verdict } : {}),
      },
      orderBy: [{ decidedOn: 'desc' }, { number: 'desc' }],
      take: 200,
    });
    const o = await this.org(orgId);
    const read = this.kpiReader(orgId, o.scale);
    const items = [];
    for (const d of rows) {
      const v = await this.view(orgId, d, read);
      const count = (s: OutcomeResult['status']) => v.outcomes.filter((x) => x.status === s).length;
      items.push({
        id: v.id,
        number: v.number,
        title: v.title,
        category: v.category,
        tags: v.tags,
        decidedOn: v.decidedOn,
        decidedBy: v.decidedBy,
        reviewDue: v.reviewDue,
        reviewOverdue: v.reviewOverdue,
        status: v.status,
        verdict: v.verdict,
        suggestedVerdict: v.suggestedVerdict,
        lessons: v.lessons,
        outcomes: { met: count('MET'), missed: count('MISSED'), notDue: count('NOT_DUE'), noValue: count('NO_VALUE') },
      });
    }
    const all = await this.prisma.decision.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } });
    const today = toDbDate(todayIso());
    return {
      items,
      totals: {
        active: all.find((x) => x.status === 'ACTIVE')?._count._all ?? 0,
        reviewed: all.find((x) => x.status === 'REVIEWED')?._count._all ?? 0,
        withdrawn: all.find((x) => x.status === 'WITHDRAWN')?._count._all ?? 0,
        dueForReview: await this.prisma.decision.count({ where: { orgId, status: 'ACTIVE', reviewDue: { lte: today } } }),
      },
      ...this.meta(),
    };
  }

  async get(orgId: string, id: string) {
    const d = await this.find(orgId, id);
    const v = await this.view(orgId, d);
    return { ...v, source: await this.sourceView(orgId, d), people: await this.names([d.createdById, d.reviewedById, d.withdrawnById]) };
  }

  /** A draft prefilled from an approved scenario or a recovery plan. Nothing is saved. */
  async draft(orgId: string, sourceType: 'SCENARIO' | 'RECOVERY_PLAN', sourceId: string) {
    if (sourceType === 'SCENARIO') {
      const s = await this.prisma.twinScenario.findFirst({ where: { orgId, id: sourceId } });
      if (!s) throw new DomainError('NOT_FOUND', 'Scenario not found', HttpStatus.NOT_FOUND);
      if (s.status !== 'APPROVED') throw new DomainError('NOT_APPROVED', 'Only an approved scenario can be recorded as a decision');
      const full = await this.twin.get(orgId, sourceId);
      const approver = s.decidedById ? (await this.names([s.decidedById]))[s.decidedById] : null;
      return {
        title: s.name.slice(0, 200),
        decision: (s.description || `Go ahead with the scenario "${s.name}".`).slice(0, 4000),
        context: [`Approved in the war room${approver ? ` by ${approver}` : ''}${s.decidedAt ? ` on ${istDate(s.decidedAt)}` : ''}.`, s.decisionNote ? `Approval note: ${s.decisionNote}` : null].filter(Boolean).join(' ').slice(0, 4000),
        category: 'GROWTH' as DecisionCategoryKey,
        tags: ['scenario'],
        decidedOn: s.decidedAt ? istDate(s.decidedAt) : todayIso(),
        decidedBy: approver,
        assumptions: (full.result.assumptions as string[]).slice(0, 30).map((text) => ({ text: text.slice(0, 1000) })),
        outcomes: [] as OutcomeInput[],
        sourceType,
        sourceId,
      };
    }
    const p = await this.prisma.recoveryPlan.findFirst({ where: { orgId, id: sourceId }, include: { actions: { orderBy: { createdAt: 'asc' } } } });
    if (!p) throw new DomainError('NOT_FOUND', 'Recovery plan not found', HttpStatus.NOT_FOUND);
    const live = p.actions.filter((a) => a.status !== 'DROPPED');
    const owners = await this.names(live.map((a) => a.ownerId));
    const lines = live.map((a) => `• ${a.title}${a.ownerId ? `, owned by ${owners[a.ownerId] ?? 'a member'}` : ''}${a.dueDate ? `, due ${fromDbDate(a.dueDate)}` : ''}`);
    return {
      title: p.name.slice(0, 200),
      decision: [`Carry out the recovery plan "${p.name}":`, ...lines].join('\n').slice(0, 4000),
      context: p.description?.slice(0, 4000) ?? null,
      category: 'COSTS' as DecisionCategoryKey,
      tags: ['recovery'],
      decidedOn: todayIso(),
      decidedBy: null,
      assumptions: live.filter((a) => a.dueDate).map((a) => ({ text: `${a.title} is done by ${fromDbDate(a.dueDate!)}.`.slice(0, 1000) })),
      outcomes: [] as OutcomeInput[],
      sourceType,
      sourceId,
    };
  }

  private async checkSource(orgId: string, input: DecisionInput) {
    if (!input.sourceType || !input.sourceId) return;
    const exists = input.sourceType === 'SCENARIO' ? await this.prisma.twinScenario.findFirst({ where: { orgId, id: input.sourceId, status: 'APPROVED' } }) : await this.prisma.recoveryPlan.findFirst({ where: { orgId, id: input.sourceId } });
    if (!exists) throw new DomainError('INVALID_SOURCE', input.sourceType === 'SCENARIO' ? 'Only an approved scenario of this organisation can be the source' : 'That recovery plan is not in this organisation');
  }

  async create(orgId: string, actor: Actor, input: DecisionInput) {
    this.checkInput(input);
    await this.checkSource(orgId, input);
    const outcomes = await this.storeOutcomes(orgId, input.decidedOn, input.outcomes);
    const d = await this.prisma.$transaction(async (tx) => {
      const last = await tx.decision.aggregate({ where: { orgId }, _max: { number: true } });
      const d = await tx.decision.create({
        data: {
          orgId,
          number: (last._max.number ?? 0) + 1,
          title: input.title,
          decision: input.decision,
          context: input.context ?? null,
          category: input.category,
          tags: [...new Set((input.tags ?? []).map((t) => t.toLowerCase()))],
          decidedOn: toDbDate(input.decidedOn),
          decidedBy: input.decidedBy ?? null,
          reviewDue: input.reviewDue ? toDbDate(input.reviewDue) : null,
          assumptions: input.assumptions.map((a) => ({ text: a.text, held: null, note: null })) as unknown as Prisma.InputJsonValue,
          outcomes: outcomes as unknown as Prisma.InputJsonValue,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'decision.recorded', entityType: 'decision', entityId: d.id, data: { number: dm(d.number), title: d.title, category: d.category, decidedOn: input.decidedOn, outcomes: input.outcomes.length, source: input.sourceType ?? null } });
      return d;
    });
    return this.get(orgId, d.id);
  }

  async update(orgId: string, actor: Actor, id: string, input: DecisionInput) {
    const before = await this.find(orgId, id);
    if (before.status !== 'ACTIVE') throw new DomainError('DECISION_FINAL', `This decision is ${before.status.toLowerCase()} and cannot be changed`, HttpStatus.CONFLICT);
    this.checkInput(input);
    const outcomes = await this.storeOutcomes(orgId, input.decidedOn, input.outcomes, fromDbDate(before.decidedOn) === input.decidedOn ? (before.outcomes as unknown as StoredOutcome[]) : []);
    const prev = before.assumptions as unknown as StoredAssumption[];
    await this.prisma.$transaction(async (tx) => {
      await tx.decision.update({
        where: { id },
        data: {
          title: input.title,
          decision: input.decision,
          context: input.context ?? null,
          category: input.category,
          tags: [...new Set((input.tags ?? []).map((t) => t.toLowerCase()))],
          decidedOn: toDbDate(input.decidedOn),
          decidedBy: input.decidedBy ?? null,
          reviewDue: input.reviewDue ? toDbDate(input.reviewDue) : null,
          assumptions: input.assumptions.map((a) => prev.find((p) => p.text === a.text) ?? { text: a.text, held: null, note: null }) as unknown as Prisma.InputJsonValue,
          outcomes: outcomes as unknown as Prisma.InputJsonValue,
          updatedById: actor.id,
        },
      });
      const changed = (['title', 'decision', 'context', 'category', 'decidedBy'] as const).filter((k) => (before[k] ?? null) !== ((input as unknown as Record<string, unknown>)[k] ?? null));
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'decision.updated',
        entityType: 'decision',
        entityId: id,
        data: { number: dm(before.number), changed, before: { title: before.title, decision: before.decision, decidedOn: fromDbDate(before.decidedOn), reviewDue: before.reviewDue ? fromDbDate(before.reviewDue) : null, assumptions: prev.map((a) => a.text), outcomes: before.outcomes }, after: { title: input.title, decision: input.decision, decidedOn: input.decidedOn, reviewDue: input.reviewDue ?? null, assumptions: input.assumptions.map((a) => a.text), outcomes: input.outcomes } },
      });
    });
    return this.get(orgId, id);
  }

  /** Records what happened: whether each assumption held, the verdict and the lessons. Measured outcomes are frozen. */
  async review(orgId: string, actor: Actor, id: string, input: ReviewInput) {
    const d = await this.find(orgId, id);
    if (d.status !== 'ACTIVE') throw new DomainError('DECISION_FINAL', `This decision is already ${d.status.toLowerCase()}`, HttpStatus.CONFLICT);
    const prev = d.assumptions as unknown as StoredAssumption[];
    if (input.assumptions.length !== prev.length) throw new DomainError('INVALID_REVIEW', `Say for each of the ${prev.length} assumptions whether it held`);
    const v = await this.view(orgId, d);
    const outcomes: StoredOutcome[] = (d.outcomes as unknown as StoredOutcome[]).map((o, i) => ({ ...o, actual: v.outcomes[i]!.actual, status: v.outcomes[i]!.status }));
    const assumptions = prev.map((a, i) => ({ text: a.text, held: input.assumptions[i]!.held, note: input.assumptions[i]!.note ?? null }));
    await this.prisma.$transaction(async (tx) => {
      await tx.decision.update({
        where: { id },
        data: { status: 'REVIEWED', verdict: input.verdict, outcomeNotes: input.outcomeNotes ?? null, lessons: input.lessons, assumptions: assumptions as unknown as Prisma.InputJsonValue, outcomes: outcomes as unknown as Prisma.InputJsonValue, reviewedById: actor.id, reviewedAt: new Date(), updatedById: actor.id },
      });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'decision.reviewed',
        entityType: 'decision',
        entityId: id,
        data: { number: dm(d.number), verdict: input.verdict, suggested: v.suggestedVerdict, outcomes: outcomes.map((o) => ({ kpi: o.kpi, measureMonth: o.measureMonth, actual: o.actual ?? null, status: o.status })), assumptionsHeld: assumptions.filter((a) => a.held === true).length, assumptionsFailed: assumptions.filter((a) => a.held === false).length },
      });
    });
    return this.get(orgId, id);
  }

  /** The decision was reversed or never carried out. It stays in the history with the reason. */
  async withdraw(orgId: string, actor: Actor, id: string, reason: string) {
    const d = await this.find(orgId, id);
    if (d.status !== 'ACTIVE') throw new DomainError('DECISION_FINAL', `This decision is already ${d.status.toLowerCase()}`, HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.decision.update({ where: { id }, data: { status: 'WITHDRAWN', withdrawnReason: reason, withdrawnById: actor.id, withdrawnAt: new Date(), updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'decision.withdrawn', entityType: 'decision', entityId: id, data: { number: dm(d.number), title: d.title, reason } });
    });
    return this.get(orgId, id);
  }
}
