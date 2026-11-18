import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { allocationLines, allocationTargetIssues, D, minorUnits } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { CostAllocationRuleDoc, costAllocationRules, costAllocationRuns } from '../db/collections/cost-allocations';
import { users } from '../db/collections/identity';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { JournalsService } from '../journals/journals.service';

export interface RuleInput {
  name: string;
  accountIds: string[];
  sourceDepartmentId: string | null;
  targets: { departmentId: string; percent: string }[];
  isActive?: boolean;
}

/**
 * Cost allocation (GL-024). MongoDB only. Rules spread the costs on chosen expense accounts from
 * one cost centre (or from costs with none) to others by percentage; a run posts the journal for
 * a period, once, and can be reversed. reports.read sees them, accounts.manage writes rules, and
 * close.manage with journals.post runs them.
 */
@Injectable()
export class CostAllocationsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  private async departments(orgId: string) {
    const rows = await this.prisma.dimensionValue.findMany({ where: { orgId, type: 'DEPARTMENT' }, select: { id: true, code: true, name: true, isActive: true }, orderBy: { code: 'asc' } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private serialize(r: CostAllocationRuleDoc, depts: Map<string, { code: string; name: string }>, accts: Map<string, { code: string; name: string }>) {
    const dept = (id: string | null) => (id ? (depts.get(id) ? `${depts.get(id)!.code} ${depts.get(id)!.name}` : 'Unknown department') : 'Costs with no department');
    return {
      id: r.id,
      name: r.name,
      isActive: r.isActive,
      accountIds: r.accountIds,
      accounts: r.accountIds.map((id) => ({ id, code: accts.get(id)?.code ?? null, name: accts.get(id)?.name ?? 'Unknown account' })),
      sourceDepartmentId: r.sourceDepartmentId,
      source: dept(r.sourceDepartmentId),
      targets: r.targets.map((t) => ({ departmentId: t.departmentId, name: dept(t.departmentId), percent: new D(t.percent).toFixed() })),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async list(org: OrgContext) {
    const [rules, runs, depts, accts] = await Promise.all([
      this.store.collection(costAllocationRules).find({}, { sort: { name: 1 } }),
      this.store.collection(costAllocationRuns).find({}, { sort: { postedAt: -1 }, limit: 100 }),
      this.departments(org.id),
      this.store.collection(accounts).find({ type: 'EXPENSE', isPostable: true }, { sort: { code: 1 } }),
    ]);
    const acctMap = new Map(accts.map((a) => [a.id, a]));
    const names = await this.names(runs.flatMap((r) => [r.postedById, r.reversedById]));
    const scale = minorUnits(org.functionalCurrency);
    return {
      currency: org.functionalCurrency,
      rules: rules.map((r) => this.serialize(r, depts, acctMap)),
      runs: runs.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        ruleName: r.ruleName,
        from: fromDbDate(r.from),
        to: fromDbDate(r.to),
        total: new D(r.total).toFixed(scale),
        status: r.status,
        journalEntryId: r.journalEntryId,
        reversalEntryId: r.reversalEntryId,
        postedBy: names.get(r.postedById) ?? null,
        postedAt: r.postedAt.toISOString(),
        reversedBy: r.reversedById ? (names.get(r.reversedById) ?? null) : null,
      })),
      options: {
        departments: [...depts.values()].filter((d) => d.isActive).map((d) => ({ id: d.id, code: d.code, name: d.name })),
        accounts: accts.filter((a) => a.isActive).map((a) => ({ id: a.id, code: a.code, name: a.name })),
      },
    };
  }

  private async check(org: OrgContext, input: RuleInput) {
    const issues = allocationTargetIssues(input.targets.map((t) => ({ id: t.departmentId, percent: t.percent })), input.sourceDepartmentId);
    if (!input.name.trim()) issues.push('Give the rule a name');
    if (!input.accountIds.length) issues.push('Choose at least one expense account to allocate');
    const depts = await this.departments(org.id);
    for (const id of [input.sourceDepartmentId, ...input.targets.map((t) => t.departmentId)]) if (id && !depts.has(id)) issues.push('Every cost centre must be a department of this organisation');
    const accts = await this.store.collection(accounts).find({ id: { $in: input.accountIds } });
    if (accts.length !== new Set(input.accountIds).size || accts.some((a) => a.type !== 'EXPENSE' || !a.isPostable)) issues.push('Only postable expense accounts are allocated');
    if (issues.length) throw new DomainError('RULE_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues: [...new Set(issues)] });
  }

  private clean(input: RuleInput) {
    return {
      name: input.name.trim(),
      accountIds: [...new Set(input.accountIds)],
      sourceDepartmentId: input.sourceDepartmentId,
      targets: input.targets.map((t) => ({ departmentId: t.departmentId, percent: new D(t.percent).toFixed() })),
    };
  }

  async create(org: OrgContext, actorId: string, input: RuleInput) {
    await this.check(org, input);
    const now = new Date();
    try {
      const r = await this.store.collection(costAllocationRules).insertOne({ orgId: org.id, ...this.clean(input), isActive: input.isActive ?? true, createdById: actorId, createdAt: now, updatedAt: now });
      await this.log(org.id, actorId, 'cost_allocation_rule.created', r.id, { name: r.name, targets: r.targets });
      return (await this.list(org)).rules.find((x) => x.id === r.id)!;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('RULE_EXISTS', `A rule named ${input.name.trim()} already exists`, HttpStatus.CONFLICT);
      throw e;
    }
  }

  async update(org: OrgContext, actorId: string, id: string, input: RuleInput) {
    const before = await this.rule(id);
    await this.check(org, input);
    try {
      await this.store.collection(costAllocationRules).updateOne({ id }, { $set: { ...this.clean(input), isActive: input.isActive ?? before.isActive, updatedAt: new Date() } });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('RULE_EXISTS', `A rule named ${input.name.trim()} already exists`, HttpStatus.CONFLICT);
      throw e;
    }
    await this.log(org.id, actorId, 'cost_allocation_rule.updated', id, { before: { name: before.name, targets: before.targets, isActive: before.isActive }, after: { name: input.name.trim(), targets: input.targets, isActive: input.isActive ?? before.isActive } });
    return (await this.list(org)).rules.find((x) => x.id === id)!;
  }

  private async rule(id: string) {
    const r = await this.store.collection(costAllocationRules).findById(id);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Allocation rule not found' });
    return r;
  }

  /** What a run would post for the period: each account's net cost in the source and its split. */
  async preview(org: OrgContext, id: string, from: string, to: string) {
    if (from > to) throw new DomainError('BAD_RANGE', 'The period starts after it ends', HttpStatus.UNPROCESSABLE_ENTITY);
    const r = await this.rule(id);
    const scale = minorUnits(org.functionalCurrency);
    const sums = await lineSums(this.store, org.id, {
      entry: postedBetween(toDbDate(from), toDbDate(to), { excludeClosing: true }),
      line: { accountId: { $in: r.accountIds }, departmentId: r.sourceDepartmentId },
      by: { accountId: 'lines.accountId' },
    });
    const costs = r.accountIds.map((accountId) => {
      const s = sums.find((x) => x.key.accountId === accountId);
      return { accountId, net: s ? s.debit.minus(s.credit).toDecimalPlaces(scale) : new D(0) };
    });
    const lines = allocationLines(costs, r.sourceDepartmentId, r.targets.map((t) => ({ id: t.departmentId, percent: t.percent })), r.name, scale);
    const total = costs.reduce((s, c) => s.plus(c.net.abs()), new D(0));
    const posted = await this.store.collection(costAllocationRuns).findOne({ ruleId: id, from: toDbDate(from), to: toDbDate(to), status: 'POSTED' });
    return { ruleId: id, from, to, currency: org.functionalCurrency, total: total.toFixed(scale), costs: costs.map((c) => ({ accountId: c.accountId, net: c.net.toFixed(scale) })), lines, alreadyPostedRunId: posted?.id ?? null };
  }

  /** Posts the allocation journal for the period, dated its last day, once per rule and period. */
  async run(org: OrgContext, actorId: string, id: string, from: string, to: string) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot post journals; it needs journals.post`, HttpStatus.FORBIDDEN);
    const r = await this.rule(id);
    if (!r.isActive) throw new DomainError('RULE_INACTIVE', 'This rule is switched off', HttpStatus.CONFLICT);
    const p = await this.preview(org, id, from, to);
    if (p.alreadyPostedRunId) throw new DomainError('ALREADY_RUN', 'This rule has already been posted for this period; reverse that run first', HttpStatus.CONFLICT);
    if (!p.lines.length) throw new DomainError('NOTHING_TO_ALLOCATE', 'There is no cost to allocate in this period', HttpStatus.UNPROCESSABLE_ENTITY);
    const je = await this.prisma.$transaction((tx) =>
      this.journals.postSystemEntry(tx, org, { id: actorId }, { date: to, source: 'ALLOCATION', memo: `Cost allocation: ${r.name} (${from} to ${to})`, reference: `ALLOC ${to}`, lines: p.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, departmentId: l.departmentId, description: l.description })) }),
    );
    let runId: string;
    try {
      runId = (await this.store.collection(costAllocationRuns).insertOne({ orgId: org.id, ruleId: id, ruleName: r.name, from: toDbDate(from), to: toDbDate(to), journalEntryId: je.id, total: p.total, status: 'POSTED', reversalEntryId: null, reversedById: null, reversedAt: null, postedById: actorId, postedAt: new Date() })).id;
    } catch (e) {
      // Someone posted the same run at the same moment: undo this journal.
      await this.prisma.$transaction((tx) => this.journals.reverseSystemEntry(tx, org, { id: actorId }, je.id, { date: to, memo: 'Duplicate cost allocation undone' }));
      if (isDuplicateKeyError(e)) throw new DomainError('ALREADY_RUN', 'This rule has already been posted for this period', HttpStatus.CONFLICT);
      throw e;
    }
    await this.log(org.id, actorId, 'cost_allocation.posted', runId, { ruleId: id, from, to, total: p.total, journalEntryId: je.id });
    return { id: runId, journalEntryId: je.id, entryNumber: je.entryNumber, total: p.total };
  }

  /** Reverses a run's journal on the same date, which frees the period for a new run. */
  async reverse(org: OrgContext, actorId: string, runId: string) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot post journals; it needs journals.post`, HttpStatus.FORBIDDEN);
    const run = await this.store.collection(costAllocationRuns).findById(runId);
    if (!run) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Allocation run not found' });
    if (run.status !== 'POSTED') throw new DomainError('ALREADY_REVERSED', 'This run has already been reversed', HttpStatus.CONFLICT);
    const rev = await this.prisma.$transaction((tx) => this.journals.reverseSystemEntry(tx, org, { id: actorId }, run.journalEntryId, { date: fromDbDate(run.to), memo: `Reversal of cost allocation: ${run.ruleName}` }));
    await this.store.collection(costAllocationRuns).updateOne({ id: runId }, { $set: { status: 'REVERSED', reversalEntryId: rev.id, reversedById: actorId, reversedAt: new Date() } });
    await this.log(org.id, actorId, 'cost_allocation.reversed', runId, { journalEntryId: run.journalEntryId, reversalEntryId: rev.id });
    return { id: runId, status: 'REVERSED', reversalEntryId: rev.id };
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.store.collection(users).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'cost_allocation', entityId, data }));
  }
}
