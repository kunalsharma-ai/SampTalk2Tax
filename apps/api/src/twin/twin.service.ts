import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { minorUnits, runTwin, twinInsights, TWIN_TEMPLATES, TwinError, type TwinActualMonth, type TwinDriverWithMeta, type TwinResult } from '@talk2tax/accounting-engine';
import { Prisma, type TwinScenario } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIst } from '../cash-flow/cash-flow.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { KpisService } from '../kpis/kpis.service';

type Actor = { id: string };
type NoteInput = { body: string; month?: number | null; changeNumber?: number | null };

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

  /**
   * Runs drivers against the current baseline, without saving anything. With `insights`, also
   * measures each change, the impact by department and the suggested remedies (re-running the
   * model, not estimating).
   */
  async simulate(orgId: string, input: Pick<ScenarioInput, 'baselineMonths' | 'horizonMonths' | 'drivers'>, opts: { insights?: boolean } = {}) {
    const a = await this.actuals(orgId, input.baselineMonths);
    const cashBuffer = await this.buffer(orgId);
    if (opts.insights) await this.checkDepartments(orgId, input.drivers);
    try {
      const result: TwinResult = runTwin({ baseline: a, drivers: input.drivers, horizonMonths: input.horizonMonths, cashBuffer });
      const insights = opts.insights ? twinInsights({ baseline: a, drivers: input.drivers, horizonMonths: input.horizonMonths, cashBuffer }, result) : undefined;
      return { currency: a.currency, actualMonths: a.months, ...result, ...(insights ? { insights } : {}) };
    } catch (e) {
      if (e instanceof TwinError) throw new DomainError('SCENARIO_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
  }

  /** Departments named on changes must be this organisation's departments. */
  private async checkDepartments(orgId: string, drivers: readonly TwinDriverWithMeta[]) {
    const ids = [...new Set(drivers.map((d) => d.departmentId).filter((x): x is string => !!x))];
    if (!ids.length) return;
    const found = await this.prisma.dimensionValue.findMany({ where: { orgId, id: { in: ids }, type: 'DEPARTMENT' }, select: { id: true } });
    const ok = new Set(found.map((f) => f.id));
    const issues = drivers.flatMap((d, i) => (d.departmentId && !ok.has(d.departmentId) ? [`Change ${i + 1}: The department was not found`] : []));
    if (issues.length) throw new DomainError('SCENARIO_INVALID', 'Some changes need fixing', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
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
      status: s.status,
      version: s.version,
      submittedById: s.submittedById,
      submittedAt: s.submittedAt?.toISOString() ?? null,
      decidedById: s.decidedById,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      decisionNote: s.decisionNote,
      createdById: s.createdById,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private async names(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
    return Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<string, string>;
  }

  private async find(orgId: string, id: string) {
    const s = await this.prisma.twinScenario.findFirst({ where: { id, orgId } });
    if (!s) throw new DomainError('NOT_FOUND', 'Scenario not found', HttpStatus.NOT_FOUND);
    return s;
  }

  async list(orgId: string) {
    const rows = await this.prisma.twinScenario.findMany({ where: { orgId }, orderBy: { updatedAt: 'desc' } });
    const people = await this.names(rows.flatMap((s) => [s.submittedById, s.decidedById, s.updatedById]));
    const notes = await this.prisma.twinScenarioNote.groupBy({ by: ['scenarioId'], where: { orgId, resolvedAt: null }, _count: { _all: true } });
    const open = new Map(notes.map((n) => [n.scenarioId, n._count._all]));
    return { items: rows.map((s) => ({ ...this.view(s), people: { submittedBy: s.submittedById ? people[s.submittedById] ?? null : null, decidedBy: s.decidedById ? people[s.decidedById] ?? null : null, updatedBy: people[s.updatedById] ?? null }, openNotes: open.get(s.id) ?? 0 })) };
  }

  /**
   * A saved scenario with a fresh run against today's actuals (with its insights), the
   * no-change run beside it, its versions, notes, and the departments its changes name.
   */
  async get(orgId: string, id: string) {
    const row = await this.find(orgId, id);
    const s = this.view(row);
    const [run, base, versions, notes] = await Promise.all([
      this.simulate(orgId, s, { insights: true }),
      this.baseline(orgId, s),
      this.prisma.twinScenarioVersion.findMany({ where: { orgId, scenarioId: id }, orderBy: { version: 'desc' } }),
      this.prisma.twinScenarioNote.findMany({ where: { orgId, scenarioId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const people = await this.names([row.createdById, row.submittedById, row.decidedById, ...versions.map((v) => v.createdById), ...notes.flatMap((n) => [n.authorId, n.resolvedById])]);
    return {
      scenario: s,
      result: run,
      baseline: { projection: base.projection },
      people,
      versions: versions.map((v) => ({ version: v.version, name: v.name, description: v.description, baselineMonths: v.baselineMonths, horizonMonths: v.horizonMonths, drivers: v.drivers as unknown as TwinDriverWithMeta[], reason: v.reason, createdById: v.createdById, createdAt: v.createdAt.toISOString() })),
      notes: notes.map((n) => this.noteView(n)),
    };
  }

  private noteView(n: { id: string; version: number; month: number | null; changeNumber: number | null; body: string; authorId: string; createdAt: Date; resolvedById: string | null; resolvedAt: Date | null }) {
    return { id: n.id, version: n.version, month: n.month, changeNumber: n.changeNumber, body: n.body, authorId: n.authorId, createdAt: n.createdAt.toISOString(), resolvedById: n.resolvedById, resolvedAt: n.resolvedAt?.toISOString() ?? null };
  }

  private async checkName(orgId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.twinScenario.findFirst({ where: { orgId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new DomainError('DUPLICATE', 'A scenario with that name already exists', HttpStatus.CONFLICT);
  }

  private async validate(orgId: string, input: ScenarioInput) {
    await this.checkDepartments(orgId, input.drivers);
    await this.simulate(orgId, input); // refuses invalid drivers with the engine's own messages
  }

  private versionRow(orgId: string, scenarioId: string, version: number, input: ScenarioInput, reason: string, actor: Actor) {
    return { orgId, scenarioId, version, name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, drivers: input.drivers as unknown as Prisma.InputJsonValue, reason, createdById: actor.id };
  }

  async create(orgId: string, actor: Actor, input: ScenarioInput) {
    await this.validate(orgId, input);
    await this.checkName(orgId, input.name);
    const s = await this.prisma.$transaction(async (tx) => {
      const s = await tx.twinScenario.create({
        data: { orgId, name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, drivers: input.drivers as unknown as Prisma.InputJsonValue, createdById: actor.id, updatedById: actor.id },
      });
      await tx.twinScenarioVersion.create({ data: this.versionRow(orgId, s.id, 1, input, 'CREATED', actor) });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.created', entityType: 'twin_scenario', entityId: s.id, data: { name: input.name, drivers: input.drivers.length } });
      return s;
    });
    return this.view(s);
  }

  /** Submitted and approved scenarios are frozen: withdraw or reopen them first. */
  private editable(s: TwinScenario) {
    if (s.status === 'SUBMITTED') throw new DomainError('SCENARIO_LOCKED', 'This scenario is waiting for approval; withdraw it before changing it', HttpStatus.CONFLICT);
    if (s.status === 'APPROVED') throw new DomainError('SCENARIO_LOCKED', 'This scenario is approved; reopen it as a draft before changing it', HttpStatus.CONFLICT);
  }

  private inputsOf(s: TwinScenario): ScenarioInput {
    return { name: s.name, description: s.description, baselineMonths: s.baselineMonths as 3 | 6 | 12, horizonMonths: s.horizonMonths, drivers: s.drivers as unknown as TwinDriverWithMeta[] };
  }

  /** Saving different inputs makes a new version and returns a rejected scenario to draft. */
  async update(orgId: string, actor: Actor, id: string, input: ScenarioInput, reason = 'EDITED') {
    const before = await this.find(orgId, id);
    this.editable(before);
    await this.validate(orgId, input);
    await this.checkName(orgId, input.name, id);
    const next = { ...input, description: input.description ?? null };
    if (isDeepStrictEqual(JSON.parse(JSON.stringify(next)), JSON.parse(JSON.stringify(this.inputsOf(before)))) && reason === 'EDITED') return this.view(before);
    const s = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.twinScenario.updateMany({
        where: { id, orgId, version: before.version, status: { in: ['DRAFT', 'REJECTED'] } },
        data: { name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, drivers: input.drivers as unknown as Prisma.InputJsonValue, updatedById: actor.id, version: before.version + 1, status: 'DRAFT', submittedById: null, submittedAt: null, decidedById: null, decidedAt: null, decisionNote: null },
      });
      if (!locked.count) throw new DomainError('CONFLICT', 'Someone else changed this scenario at the same time; reload it and try again', HttpStatus.CONFLICT);
      await tx.twinScenarioVersion.create({ data: this.versionRow(orgId, id, before.version + 1, input, reason, actor) });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.updated', entityType: 'twin_scenario', entityId: id, data: { name: input.name, version: before.version + 1, reason, before: { drivers: before.drivers, horizonMonths: before.horizonMonths, baselineMonths: before.baselineMonths, status: before.status }, drivers: input.drivers.length } });
      return tx.twinScenario.findUniqueOrThrow({ where: { id } });
    });
    return this.view(s);
  }

  /** Makes an earlier version's inputs the newest version. */
  async restore(orgId: string, actor: Actor, id: string, version: number) {
    const v = await this.prisma.twinScenarioVersion.findFirst({ where: { orgId, scenarioId: id, version } });
    if (!v) throw new DomainError('NOT_FOUND', 'Version not found', HttpStatus.NOT_FOUND);
    const current = await this.find(orgId, id);
    if (current.version === version) throw new DomainError('VALIDATION_FAILED', 'That is already the current version', HttpStatus.UNPROCESSABLE_ENTITY);
    return this.update(orgId, actor, id, { name: v.name, description: v.description, baselineMonths: v.baselineMonths as 3 | 6 | 12, horizonMonths: v.horizonMonths, drivers: v.drivers as unknown as TwinDriverWithMeta[] }, `RESTORED_FROM_${version}`);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    const s = await this.find(orgId, id);
    if (s.status === 'APPROVED' || s.status === 'SUBMITTED') throw new DomainError('SCENARIO_LOCKED', s.status === 'APPROVED' ? 'An approved scenario cannot be deleted; reopen it as a draft first' : 'This scenario is waiting for approval; withdraw it first', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.twinScenario.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.deleted', entityType: 'twin_scenario', entityId: id, data: { name: s.name, version: s.version } });
    });
    return { deleted: true };
  }

  /** Moves a scenario through its approval, guarding the expected current status. */
  private async transition(orgId: string, actor: Actor, id: string, from: ('DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED')[], data: Prisma.TwinScenarioUpdateManyMutationInput, action: string, extra: Record<string, unknown> = {}) {
    const s = await this.find(orgId, id);
    if (!from.includes(s.status)) {
      const words = { DRAFT: 'a draft', SUBMITTED: 'waiting for approval', APPROVED: 'approved', REJECTED: 'rejected' } as const;
      throw new DomainError('INVALID_STATUS', `This scenario is ${words[s.status]}, so that cannot be done now`, HttpStatus.CONFLICT);
    }
    return { s, run: async (check?: () => void) => {
      check?.();
      return this.prisma.$transaction(async (tx) => {
        const done = await tx.twinScenario.updateMany({ where: { id, orgId, status: s.status, version: s.version }, data });
        if (!done.count) throw new DomainError('CONFLICT', 'Someone else changed this scenario at the same time; reload it and try again', HttpStatus.CONFLICT);
        await this.audit.append(tx, { orgId, actorId: actor.id, action, entityType: 'twin_scenario', entityId: id, data: { name: s.name, version: s.version, from: s.status, ...extra } });
        return this.view(await tx.twinScenario.findUniqueOrThrow({ where: { id } }));
      });
    } };
  }

  async submit(orgId: string, actor: Actor, id: string) {
    const t = await this.transition(orgId, actor, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedById: actor.id, submittedAt: new Date(), decidedById: null, decidedAt: null, decisionNote: null }, 'twin_scenario.submitted');
    return t.run();
  }

  async withdraw(orgId: string, actor: Actor, id: string) {
    const t = await this.transition(orgId, actor, id, ['SUBMITTED'], { status: 'DRAFT', submittedById: null, submittedAt: null }, 'twin_scenario.withdrawn');
    return t.run();
  }

  async decide(orgId: string, actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', note: string | null) {
    if (decision === 'REJECTED' && !note?.trim()) throw new DomainError('VALIDATION_FAILED', 'Say why the scenario is rejected', HttpStatus.UNPROCESSABLE_ENTITY);
    const t = await this.transition(orgId, actor, id, ['SUBMITTED'], { status: decision, decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim() || null }, decision === 'APPROVED' ? 'twin_scenario.approved' : 'twin_scenario.rejected', { note: note?.trim() || null });
    return t.run(() => {
      if (t.s.submittedById === actor.id) throw new DomainError('SELF_APPROVAL', 'Someone other than the person who submitted it must decide on a scenario', HttpStatus.FORBIDDEN);
    });
  }

  async reopen(orgId: string, actor: Actor, id: string) {
    const t = await this.transition(orgId, actor, id, ['APPROVED'], { status: 'DRAFT', submittedById: null, submittedAt: null, decidedById: null, decidedAt: null, decisionNote: null }, 'twin_scenario.reopened');
    return t.run();
  }

  // ---- notes (war-room annotations)

  async addNote(orgId: string, actor: Actor, id: string, input: NoteInput) {
    const s = await this.find(orgId, id);
    if (input.month && input.month > s.horizonMonths) throw new DomainError('VALIDATION_FAILED', `Choose a month from 1 to ${s.horizonMonths}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const drivers = s.drivers as unknown as unknown[];
    if (input.changeNumber && input.changeNumber > drivers.length) throw new DomainError('VALIDATION_FAILED', `This scenario has ${drivers.length} change${drivers.length === 1 ? '' : 's'}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const n = await this.prisma.$transaction(async (tx) => {
      const n = await tx.twinScenarioNote.create({ data: { orgId, scenarioId: id, version: s.version, month: input.month ?? null, changeNumber: input.changeNumber ?? null, body: input.body.trim(), authorId: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.note_added', entityType: 'twin_scenario', entityId: id, data: { noteId: n.id, version: s.version, month: n.month, changeNumber: n.changeNumber } });
      return n;
    });
    return this.noteView(n);
  }

  private async findNote(orgId: string, id: string, noteId: string) {
    const n = await this.prisma.twinScenarioNote.findFirst({ where: { orgId, scenarioId: id, id: noteId } });
    if (!n) throw new DomainError('NOT_FOUND', 'Note not found', HttpStatus.NOT_FOUND);
    return n;
  }

  /** The author or anyone who manages scenarios can mark a note resolved, or open it again. */
  async resolveNote(orgId: string, actor: Actor, canManage: boolean, id: string, noteId: string, resolved: boolean) {
    const n = await this.findNote(orgId, id, noteId);
    if (n.authorId !== actor.id && !canManage) throw new DomainError('FORBIDDEN', 'Only the author or someone who manages scenarios can resolve this note', HttpStatus.FORBIDDEN);
    const u = await this.prisma.$transaction(async (tx) => {
      const u = await tx.twinScenarioNote.update({ where: { id: noteId }, data: resolved ? { resolvedById: actor.id, resolvedAt: new Date() } : { resolvedById: null, resolvedAt: null } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: resolved ? 'twin_scenario.note_resolved' : 'twin_scenario.note_reopened', entityType: 'twin_scenario', entityId: id, data: { noteId } });
      return u;
    });
    return this.noteView(u);
  }

  async deleteNote(orgId: string, actor: Actor, id: string, noteId: string) {
    const n = await this.findNote(orgId, id, noteId);
    if (n.authorId !== actor.id) throw new DomainError('FORBIDDEN', 'Only the author can delete a note', HttpStatus.FORBIDDEN);
    await this.prisma.$transaction(async (tx) => {
      await tx.twinScenarioNote.delete({ where: { id: noteId } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'twin_scenario.note_deleted', entityType: 'twin_scenario', entityId: id, data: { noteId, body: n.body } });
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
    const summary = (name: string, id: string | null, r: Awaited<ReturnType<TwinService['simulate']>>, s?: { status: string }) => ({
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
      riskList: r.risks,
      status: s?.status ?? null,
      cash: r.projection.months.map((m) => m.closingCash),
    });
    return {
      currency: base.currency,
      horizonMonths,
      baselineMonths,
      months: base.projection.months.map((m) => m.month),
      rows: [summary('No change (baseline)', null, base), ...scenarios.map((s, i) => summary(s.name, s.id, runs[i]!, s))],
    };
  }
}
