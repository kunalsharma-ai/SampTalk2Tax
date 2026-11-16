import { HttpStatus, Injectable } from '@nestjs/common';
import { minorUnits, recoveryForecast, recoveryOptions, type RecoveryCustomer, type RecoveryExpense, type RecoveryInput, type RecoveryOption, type RecoverySupplier, type TwinDriverWithMeta } from '@talk2tax/accounting-engine';
import { Prisma, type RecoveryAction, type RecoveryPlan } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIst } from '../cash-flow/cash-flow.service';
import { toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { contactNames, documentEntrySums, lineSums, postedBetween } from '../db/ledger-queries';
import { PrismaService } from '../common/prisma.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { TwinService } from '../twin/twin.service';

type Actor = { id: string };
type Months = { baselineMonths: 3 | 6 | 12; horizonMonths: number };
type ActionStatus = 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'DROPPED';

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
 * The financial recovery planner. Options are worked out from the books every time (who owes
 * money, whom the business buys from, what it spends on) and measured with the digital twin.
 * A plan stores the options people choose, with owners, due dates and progress. The planner
 * never posts, pays, borrows or changes anything outside its own two tables.
 */
@Injectable()
export class RecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly twin: TwinService,
    private readonly subledger: SubledgerService,
    private readonly store: DocumentStoreService,
  ) {}

  /** Everything the engine needs, read from the posted books. */
  private async input(orgId: string, q: Months): Promise<RecoveryInput> {
    const today = todayIst();
    const a = await this.twin.actuals(orgId, q.baselineMonths);
    const cashBuffer = await this.twin.buffer(orgId);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    const scale = minorUnits(org.functionalCurrency);
    const last = shiftMonth(today.slice(0, 7), -1);
    const first = shiftMonth(last, -(q.baselineMonths - 1));
    const from = toDbDate(`${first}-01`);
    const to = toDbDate(monthEnd(last));

    const ar = await this.subledger.ageing(org, 'SALES', today);
    const customers: RecoveryCustomer[] = ar.rows.map((r) => {
      const v = r as unknown as Record<string, string>;
      const sum = (...k: string[]) => k.reduce((s, x) => s.plus(v[x] ?? 0), new Prisma.Decimal(0));
      return {
        contactId: r.contactId,
        name: r.contactName,
        overdue1to30: v.days1to30 ?? '0',
        overdue31to90: sum('days31to60', 'days61to90').toFixed(scale),
        overdueOver90: v.over90 ?? '0',
      };
    });

    const ap = await this.subledger.ageing(org, 'PURCHASES', today);
    const owed = new Map(ap.rows.map((r) => [r.contactId, (r as unknown as Record<string, string>).balance ?? '0']));
    const spend = org.apAccountId
      ? await documentEntrySums(this.prisma, this.store, orgId, { kind: 'BILL', status: 'POSTED', issueDate: { gte: from, lte: to } }, [org.apAccountId]).then(async (lines) => {
          const names = await contactNames(this.prisma, orgId, lines.map((l) => l.contactId));
          const per = new Map<string, Prisma.Decimal>();
          for (const l of lines) per.set(l.contactId, (per.get(l.contactId) ?? new Prisma.Decimal(0)).plus(l.credit.minus(l.debit).toFixed()));
          return [...per.entries()].map(([id, amount]) => ({ contact_id: id, name: names.get(id) ?? '', amount }));
        })
      : [];
    const suppliers: RecoverySupplier[] = spend.map((s) => ({
      contactId: s.contact_id,
      name: s.name,
      monthlySpend: new Prisma.Decimal(s.amount).div(q.baselineMonths).toFixed(scale),
      balance: owed.get(s.contact_id) ?? (0).toFixed(scale),
    }));

    const opex = await this.prisma.account.findMany({ where: { orgId, type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' }, select: { id: true, code: true, name: true } });
    const opexSums = opex.length ? await lineSums(this.store, orgId, { entry: postedBetween(from, to, { excludeClosing: true }), line: { accountId: { $in: opex.map((x) => x.id) } }, by: { accountId: 'lines.accountId' } }) : [];
    const lines = opexSums.map((r) => {
      const x = opex.find((o) => o.id === r.key.accountId)!;
      return { id: x.id, code: x.code, name: x.name, amount: r.debit.minus(r.credit).toFixed() };
    });
    const expenses: RecoveryExpense[] = lines.map((x) => ({ accountId: x.id, code: x.code, name: x.name, monthly: new Prisma.Decimal(x.amount).div(q.baselineMonths).toFixed(scale) }));

    return { baseline: a, horizonMonths: q.horizonMonths, cashBuffer, customers, suppliers, expenses };
  }

  /** Recovery options right now, each measured against taking no action. */
  async options(orgId: string, q: Months) {
    const input = await this.input(orgId, q);
    return { ...recoveryOptions(input), baselineMonths: q.baselineMonths, horizonMonths: q.horizonMonths, firstMonth: shiftMonth(todayIst().slice(0, 7), 0) };
  }

  // ---- plans

  private planView(p: RecoveryPlan) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      baselineMonths: p.baselineMonths as 3 | 6 | 12,
      horizonMonths: p.horizonMonths,
      createdById: p.createdById,
      updatedById: p.updatedById,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      closedAt: p.closedAt?.toISOString() ?? null,
    };
  }

  private actionView(a: RecoveryAction) {
    return {
      id: a.id,
      optionKey: a.optionKey,
      category: a.category,
      title: a.title,
      detail: a.detail,
      drivers: a.drivers as unknown as TwinDriverWithMeta[],
      targets: a.targets as unknown as RecoveryOption['targets'],
      risks: a.risks as unknown as string[],
      needsDecision: a.needsDecision,
      status: a.status,
      ownerId: a.ownerId,
      dueDate: a.dueDate?.toISOString().slice(0, 10) ?? null,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  private async find(orgId: string, id: string) {
    const p = await this.prisma.recoveryPlan.findFirst({ where: { id, orgId } });
    if (!p) throw new DomainError('NOT_FOUND', 'Recovery plan not found', HttpStatus.NOT_FOUND);
    return p;
  }

  private open(p: RecoveryPlan) {
    if (p.status === 'CLOSED') throw new DomainError('PLAN_CLOSED', 'This plan is closed; reopen it to change it', HttpStatus.CONFLICT);
  }

  async list(orgId: string) {
    const plans = await this.prisma.recoveryPlan.findMany({ where: { orgId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] });
    const counts = await this.prisma.recoveryAction.groupBy({ by: ['planId', 'status'], where: { orgId }, _count: { _all: true } });
    return {
      items: plans.map((p) => {
        const c = counts.filter((x) => x.planId === p.id);
        const n = (s: ActionStatus) => c.find((x) => x.status === s)?._count._all ?? 0;
        return { ...this.planView(p), actions: { planned: n('PLANNED'), inProgress: n('IN_PROGRESS'), done: n('DONE'), dropped: n('DROPPED') } };
      }),
    };
  }

  async create(orgId: string, actor: Actor, input: { name: string; description?: string | null } & Months) {
    if (await this.prisma.recoveryPlan.findFirst({ where: { orgId, name: input.name } })) throw new DomainError('DUPLICATE', 'A recovery plan with that name already exists', HttpStatus.CONFLICT);
    const p = await this.prisma.$transaction(async (tx) => {
      const p = await tx.recoveryPlan.create({ data: { orgId, name: input.name, description: input.description ?? null, baselineMonths: input.baselineMonths, horizonMonths: input.horizonMonths, createdById: actor.id, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'recovery_plan.created', entityType: 'recovery_plan', entityId: p.id, data: { name: p.name } });
      return p;
    });
    return this.planView(p);
  }

  /** The plan, its actions, the options not yet in it, and the forecast of the active actions together. */
  async get(orgId: string, id: string) {
    const p = await this.find(orgId, id);
    const actions = await this.prisma.recoveryAction.findMany({ where: { orgId, planId: id }, orderBy: { createdAt: 'asc' } });
    const q = { baselineMonths: p.baselineMonths as 3 | 6 | 12, horizonMonths: p.horizonMonths };
    const input = await this.input(orgId, q);
    const opts = recoveryOptions(input);
    const counted = actions.filter((a) => a.status !== 'DROPPED');
    const forecast = recoveryForecast(input, counted.flatMap((a) => a.drivers as unknown as TwinDriverWithMeta[]));
    const taken = new Set(actions.map((a) => a.optionKey));
    const ownerIds = [...new Set(actions.map((a) => a.ownerId).filter((x): x is string => !!x))];
    const users = ownerIds.length ? await this.prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
    return {
      plan: this.planView(p),
      currency: opts.currency,
      firstMonth: shiftMonth(todayIst().slice(0, 7), 0),
      actions: actions.map((a) => this.actionView(a)),
      owners: Object.fromEntries(users.map((u) => [u.id, u.name])),
      forecast,
      options: opts.options.filter((o) => !taken.has(o.key)),
      /** Options in the plan that the books no longer suggest (for example, nothing is overdue any more). */
      stale: actions.filter((a) => !opts.options.some((o) => o.key === a.optionKey)).map((a) => a.id),
    };
  }

  async update(orgId: string, actor: Actor, id: string, input: { name?: string; description?: string | null; status?: 'DRAFT' | 'ACTIVE' | 'CLOSED' }) {
    const p = await this.find(orgId, id);
    if (p.status === 'CLOSED' && (input.status ?? 'CLOSED') === 'CLOSED' && (input.name !== undefined || input.description !== undefined)) this.open(p);
    if (input.name && input.name !== p.name && (await this.prisma.recoveryPlan.findFirst({ where: { orgId, name: input.name, NOT: { id } } }))) {
      throw new DomainError('DUPLICATE', 'A recovery plan with that name already exists', HttpStatus.CONFLICT);
    }
    const status = input.status ?? p.status;
    const u = await this.prisma.$transaction(async (tx) => {
      const u = await tx.recoveryPlan.update({
        where: { id },
        data: { name: input.name ?? p.name, description: input.description === undefined ? p.description : input.description, status, closedAt: status === 'CLOSED' ? (p.closedAt ?? new Date()) : null, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: status !== p.status ? `recovery_plan.${status === 'ACTIVE' ? 'activated' : status === 'CLOSED' ? 'closed' : 'returned_to_draft'}` : 'recovery_plan.updated', entityType: 'recovery_plan', entityId: id, data: { name: u.name, from: p.status, to: status } });
      return u;
    });
    return this.planView(u);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    const p = await this.find(orgId, id);
    if (p.status !== 'DRAFT') throw new DomainError('PLAN_IN_USE', 'Only a draft plan can be deleted; close an active plan instead so its history is kept', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryPlan.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'recovery_plan.deleted', entityType: 'recovery_plan', entityId: id, data: { name: p.name } });
    });
    return { deleted: true };
  }

  // ---- actions

  /** Takes one of the current options into the plan, as the options stand today. */
  async addAction(orgId: string, actor: Actor, id: string, optionKey: string) {
    const p = await this.find(orgId, id);
    this.open(p);
    const opts = recoveryOptions(await this.input(orgId, { baselineMonths: p.baselineMonths as 3 | 6 | 12, horizonMonths: p.horizonMonths }));
    const o = opts.options.find((x) => x.key === optionKey);
    if (!o) throw new DomainError('OPTION_NOT_AVAILABLE', 'That option is not available for this organisation now', HttpStatus.UNPROCESSABLE_ENTITY);
    if (await this.prisma.recoveryAction.findFirst({ where: { orgId, planId: id, optionKey } })) throw new DomainError('DUPLICATE', 'That option is already in the plan', HttpStatus.CONFLICT);
    const a = await this.prisma.$transaction(async (tx) => {
      const a = await tx.recoveryAction.create({
        data: {
          orgId,
          planId: id,
          optionKey: o.key,
          category: o.category,
          title: o.title,
          detail: o.detail,
          drivers: o.drivers as unknown as Prisma.InputJsonValue,
          targets: o.targets as unknown as Prisma.InputJsonValue,
          risks: o.risks as unknown as Prisma.InputJsonValue,
          needsDecision: o.needsDecision,
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
      await tx.recoveryPlan.update({ where: { id }, data: { updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'recovery_action.added', entityType: 'recovery_plan', entityId: id, data: { actionId: a.id, optionKey: o.key, title: o.title, effect: o.effect } });
      return a;
    });
    return this.actionView(a);
  }

  private async findAction(orgId: string, planId: string, actionId: string) {
    const a = await this.prisma.recoveryAction.findFirst({ where: { orgId, planId, id: actionId } });
    if (!a) throw new DomainError('NOT_FOUND', 'Action not found', HttpStatus.NOT_FOUND);
    return a;
  }

  async updateAction(orgId: string, actor: Actor, planId: string, actionId: string, input: { status?: ActionStatus; ownerId?: string | null; dueDate?: string | null; note?: string | null }) {
    const p = await this.find(orgId, planId);
    this.open(p);
    const a = await this.findAction(orgId, planId, actionId);
    if (input.ownerId) {
      const m = await this.prisma.membership.findFirst({ where: { orgId, userId: input.ownerId } });
      if (!m) throw new DomainError('VALIDATION_FAILED', 'Choose an owner who is a member of this organisation', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const u = await this.prisma.$transaction(async (tx) => {
      const u = await tx.recoveryAction.update({
        where: { id: actionId },
        // Only the fields sent are written, so two quick edits of different fields never undo each other.
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? toDbDate(input.dueDate) : null } : {}),
          ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
          updatedById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'recovery_action.updated', entityType: 'recovery_plan', entityId: planId, data: { actionId, title: a.title, from: { status: a.status, ownerId: a.ownerId, dueDate: a.dueDate?.toISOString().slice(0, 10) ?? null }, to: { status: u.status, ownerId: u.ownerId, dueDate: u.dueDate?.toISOString().slice(0, 10) ?? null } } });
      return u;
    });
    return this.actionView(u);
  }

  async removeAction(orgId: string, actor: Actor, planId: string, actionId: string) {
    const p = await this.find(orgId, planId);
    this.open(p);
    const a = await this.findAction(orgId, planId, actionId);
    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryAction.delete({ where: { id: actionId } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'recovery_action.removed', entityType: 'recovery_plan', entityId: planId, data: { actionId, optionKey: a.optionKey, title: a.title } });
    });
    return { deleted: true };
  }

  /**
   * Copies the plan's counted actions into a digital-twin scenario, so it can be refined and taken
   * through the war room's approval.
   */
  async toScenario(orgId: string, actor: Actor, id: string) {
    const p = await this.find(orgId, id);
    const actions = await this.prisma.recoveryAction.findMany({ where: { orgId, planId: id, status: { not: 'DROPPED' } }, orderBy: { createdAt: 'asc' } });
    if (!actions.length) throw new DomainError('VALIDATION_FAILED', 'Add at least one action to the plan first', HttpStatus.UNPROCESSABLE_ENTITY);
    const drivers = actions.flatMap((a) => a.drivers as unknown as TwinDriverWithMeta[]);
    let name = `Recovery: ${p.name}`.slice(0, 120);
    for (let i = 2; await this.prisma.twinScenario.findFirst({ where: { orgId, name } }); i++) name = `Recovery: ${p.name}`.slice(0, 112) + ` (${i})`;
    const s = await this.twin.create(orgId, actor, { name, description: `From the recovery plan "${p.name}": ${actions.map((a) => a.title).join('; ')}`.slice(0, 1000), baselineMonths: p.baselineMonths as 3 | 6 | 12, horizonMonths: p.horizonMonths, drivers });
    return { scenarioId: s.id, name: s.name };
  }
}
