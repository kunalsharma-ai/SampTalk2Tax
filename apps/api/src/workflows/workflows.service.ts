import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ASSIGNABLE_ROLES,
  Condition,
  CONDITION_OPERATORS,
  evaluateConditions,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  OPERATOR_LABELS,
  triggerDef,
  validateWorkflow,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS,
  WORKFLOW_TRIGGER_DEFS,
  WorkflowAction,
  WorkflowDefinition,
  WorkflowError,
  WorkflowTrigger,
} from '@talk2tax/accounting-engine';
import { Prisma, WorkflowRunStatus } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { ROLE_LABELS, TasksService } from '../tasks/tasks.service';
import { checkWebhookUrl, WebhookAddressError } from './webhook';
import { loadEventFacts } from './workflow-facts';
import { Attempt, WorkflowRunnerService } from './workflow-runner.service';

type Actor = { id: string };

export interface WorkflowInput {
  name: string;
  description?: string | null;
  trigger: WorkflowTrigger;
  conditions: Condition[];
  actions: WorkflowAction[];
}

/** Most recent events looked at when choosing one to test a workflow on. */
const TEST_LOOKBACK = 100;
/** Most actions a manual retry can bring a delivery to. */
const MAX_TOTAL_ATTEMPTS = 20;

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

type RunRow = Prisma.WorkflowRunGetPayload<{ include: { actions: true } }>;

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly runner: WorkflowRunnerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ catalogue

  /** Everything the builder offers: triggers and their facts, operators, who tasks can go to. */
  async catalogue(orgId: string) {
    const members = await this.prisma.membership.findMany({ where: { orgId }, select: { userId: true, role: true, user: { select: { name: true, email: true } } }, orderBy: { createdAt: 'asc' } });
    return {
      triggers: WORKFLOW_TRIGGER_DEFS.map((t) => ({ key: t.key, label: t.label, description: t.description, facts: t.facts })),
      operators: Object.fromEntries(Object.entries(CONDITION_OPERATORS).map(([type, ops]) => [type, ops.map((op) => ({ op, label: OPERATOR_LABELS[op] }))])),
      roles: ASSIGNABLE_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] })),
      members: members.filter((m) => hasPermission(m.role as RoleName, 'tasks.use')).map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role })),
      limits: { conditions: MAX_CONDITIONS, actions: MAX_ACTIONS, webhookAttempts: WEBHOOK_MAX_ATTEMPTS, retryDelaysSeconds: WEBHOOK_RETRY_DELAYS },
      webhooksMustBeHttps: !this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
    };
  }

  // ------------------------------------------------------------------ definitions

  private async check(tx: Tx, orgId: string, input: WorkflowInput): Promise<WorkflowDefinition> {
    let def: WorkflowDefinition;
    try {
      def = validateWorkflow({ trigger: input.trigger, conditions: input.conditions, actions: input.actions }, { allowHttp: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS });
    } catch (e) {
      if (e instanceof WorkflowError) throw new DomainError('INVALID_WORKFLOW', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
    const issues: string[] = [];
    for (const [i, a] of def.actions.entries()) {
      if (a.type === 'WEBHOOK') {
        try {
          checkWebhookUrl(a.url, this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
        } catch (e) {
          if (!(e instanceof WebhookAddressError)) throw e;
          issues.push(`Action ${i + 1}: ${e.message}`);
        }
      }
      if (a.type === 'CREATE_TASK' && 'userId' in a.assignTo && !(await this.tasks.assignableMember(tx, orgId, a.assignTo.userId))) issues.push(`Action ${i + 1}: that person is not a member who can work on tasks`);
    }
    if (issues.length) throw new DomainError('INVALID_WORKFLOW', issues.length === 1 ? issues[0] : `${issues.length} problems in the workflow`, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return def;
  }

  async create(org: OrgContext, actor: Actor, input: WorkflowInput) {
    const id = await this.prisma.$transaction(async (tx) => {
      const def = await this.check(tx, org.id, input);
      const w = await tx.workflow.create({ data: { orgId: org.id, name: input.name, description: input.description || null, currentVersion: 1, signingSecret: newSecret(), createdById: actor.id } });
      await tx.workflowVersion.create({ data: { orgId: org.id, workflowId: w.id, version: 1, trigger: def.trigger, conditions: def.conditions as unknown as Prisma.InputJsonValue, actions: def.actions as unknown as Prisma.InputJsonValue, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'workflow.created', entityType: 'workflow', entityId: w.id, data: { name: w.name, trigger: def.trigger, conditions: def.conditions.length, actions: def.actions.map((a) => a.type) } });
      return w.id;
    });
    return this.get(org.id, id);
  }

  private async lock(tx: Tx, orgId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM workflows WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const w = await tx.workflow.findFirst({ where: { id, orgId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!w) throw new NotFoundException('Workflow not found');
    return w;
  }

  /**
   * Saves changes. A change to the trigger, conditions or actions makes a new version; runs
   * keep the version they ran. baseVersion must be the version the editor started from.
   */
  async update(org: OrgContext, actor: Actor, id: string, input: WorkflowInput & { baseVersion: number; note?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const w = await this.lock(tx, org.id, id);
      if (w.currentVersion !== input.baseVersion) {
        throw new DomainError('WORKFLOW_CHANGED', `Someone saved version ${w.currentVersion} of this workflow while you were editing. Reload it and make your change again.`, HttpStatus.CONFLICT);
      }
      const def = await this.check(tx, org.id, input);
      const cur = w.versions[0];
      // Compared with keys sorted: PostgreSQL stores JSON objects with its own key order.
      const changed = cur.trigger !== def.trigger || stable(cur.conditions) !== stable(def.conditions) || stable(cur.actions) !== stable(def.actions);
      const version = changed ? w.currentVersion + 1 : w.currentVersion;
      if (changed) {
        await tx.workflowVersion.create({ data: { orgId: org.id, workflowId: id, version, trigger: def.trigger, conditions: def.conditions as unknown as Prisma.InputJsonValue, actions: def.actions as unknown as Prisma.InputJsonValue, note: input.note || null, createdById: actor.id } });
      }
      await tx.workflow.update({ where: { id }, data: { name: input.name, description: input.description || null, currentVersion: version } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'workflow.updated', entityType: 'workflow', entityId: id, data: { name: input.name, version, newVersion: changed, note: input.note || null } });
    });
    return this.get(org.id, id);
  }

  /**
   * Turning a workflow on: it acts on what happens from now, never on earlier events.
   * Turning it off stops new runs; webhooks already queued are still sent.
   */
  async setEnabled(org: OrgContext, actor: Actor, id: string, enabled: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const w = await this.lock(tx, org.id, id);
      if (w.enabled === enabled) return;
      let from: bigint | null = w.activeFromEventId;
      if (enabled) {
        // Taken under the organisation's audit lock, so no event can commit below this point afterwards.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'audit:' + org.id}))`;
        from = (await tx.auditEvent.aggregate({ where: { orgId: org.id }, _max: { id: true } }))._max.id ?? 0n;
      }
      await tx.workflow.update({ where: { id }, data: { enabled, activeFromEventId: from } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: enabled ? 'workflow.turned_on' : 'workflow.turned_off', entityType: 'workflow', entityId: id, data: { name: w.name, version: w.currentVersion } });
    });
    return this.get(org.id, id);
  }

  async rotateSecret(org: OrgContext, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, org.id, id);
      await tx.workflow.update({ where: { id }, data: { signingSecret: newSecret() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'workflow.secret_rotated', entityType: 'workflow', entityId: id });
    });
    return this.get(org.id, id);
  }

  // ------------------------------------------------------------------ reading

  async list(orgId: string) {
    const rows = await this.prisma.workflow.findMany({ where: { orgId }, orderBy: [{ enabled: 'desc' }, { name: 'asc' }], include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    const ids = rows.map((r) => r.id);
    const [last, counts] = await Promise.all([
      ids.length ? this.prisma.workflowRun.findMany({ where: { orgId, workflowId: { in: ids }, status: { not: 'TEST' } }, orderBy: { createdAt: 'desc' }, distinct: ['workflowId'], select: { workflowId: true, status: true, createdAt: true } }) : [],
      ids.length ? this.prisma.workflowRun.groupBy({ by: ['workflowId', 'status'], where: { orgId, workflowId: { in: ids }, status: { not: 'TEST' }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: true }) : [],
    ]);
    const lastBy = new Map(last.map((l) => [l.workflowId, l]));
    return rows.map((w) => {
      const v = w.versions[0];
      const c = (s: WorkflowRunStatus) => counts.find((x) => x.workflowId === w.id && x.status === s)?._count ?? 0;
      const l = lastBy.get(w.id);
      return {
        id: w.id,
        name: w.name,
        description: w.description,
        enabled: w.enabled,
        version: w.currentVersion,
        trigger: v.trigger,
        triggerLabel: triggerDef(v.trigger).label,
        conditions: (v.conditions as unknown as Condition[]).length,
        actions: (v.actions as unknown as WorkflowAction[]).map((a) => a.type),
        lastRun: l ? { status: l.status, at: l.createdAt.toISOString() } : null,
        last30Days: { acted: c('SUCCEEDED') + c('RUNNING'), skipped: c('SKIPPED'), failed: c('FAILED') },
      };
    });
  }

  async get(orgId: string, id: string) {
    const w = await this.prisma.workflow.findFirst({ where: { id, orgId }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!w) throw new NotFoundException('Workflow not found');
    const users = await this.names([w.createdById, ...w.versions.map((v) => v.createdById)]);
    const v = w.versions[0];
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      enabled: w.enabled,
      version: w.currentVersion,
      trigger: v.trigger,
      triggerLabel: triggerDef(v.trigger).label,
      conditions: v.conditions as unknown as Condition[],
      actions: v.actions as unknown as WorkflowAction[],
      signingSecret: w.signingSecret,
      createdBy: users.get(w.createdById) ?? null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
      versions: w.versions.map((x) => ({ version: x.version, trigger: x.trigger, note: x.note, createdBy: users.get(x.createdById) ?? null, createdAt: x.createdAt.toISOString() })),
      recentRuns: await this.runs(orgId, id, { limit: 20 }),
    };
  }

  async runs(orgId: string, workflowId: string, q: { status?: WorkflowRunStatus; limit?: number; before?: string }) {
    const w = await this.prisma.workflow.findFirst({ where: { id: workflowId, orgId }, select: { id: true } });
    if (!w) throw new NotFoundException('Workflow not found');
    const before = q.before ? await this.prisma.workflowRun.findFirst({ where: { id: q.before, orgId }, select: { createdAt: true } }) : null;
    const rows = await this.prisma.workflowRun.findMany({
      where: { orgId, workflowId, ...(q.status ? { status: q.status } : {}), ...(before ? { createdAt: { lt: before.createdAt } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 50,
      include: { actions: { orderBy: { position: 'asc' } } },
    });
    return this.serializeRuns(rows);
  }

  async run(orgId: string, runId: string) {
    const r = await this.prisma.workflowRun.findFirst({ where: { id: runId, orgId }, include: { actions: { orderBy: { position: 'asc' } } } });
    if (!r) throw new NotFoundException('Run not found');
    return (await this.serializeRuns([r]))[0];
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }

  private async serializeRuns(rows: RunRow[]) {
    const users = await this.names(rows.map((r) => r.testedById));
    const links = rows.map((r) => ((r.facts as { _link?: { type: string; id: string } })._link ?? { type: null, id: null }) as { type: string | null; id: string | null });
    const path = await this.tasks.linkPaths(this.prisma, links);
    return rows.map((r, i) => {
      const def = triggerDef(r.trigger);
      const facts = r.facts as Record<string, string | null>;
      return {
        id: r.id,
        workflowId: r.workflowId,
        version: r.version,
        trigger: r.trigger,
        triggerLabel: def.label,
        status: r.status,
        error: r.error,
        eventId: r.eventId?.toString() ?? null,
        link: path(links[i]),
        facts: def.facts.map((f) => ({ key: f.key, label: f.label, type: f.type, value: facts[f.key] ?? null, display: f.options?.find((o) => o.value === facts[f.key])?.label ?? null })),
        conditions: r.conditions as unknown as { label: string; passed: boolean; actual: string | null }[],
        actions: r.actions.map((a) => {
          const result = a.result as { taskId?: string; attempts?: Attempt[]; preview?: unknown; test?: Attempt };
          return {
            position: a.position,
            type: a.type,
            status: a.status,
            input: a.input,
            taskId: result.taskId ?? null,
            attempts: a.attempts,
            history: result.attempts ?? (result.test ? [result.test] : []),
            nextAttemptAt: a.status === 'PENDING' ? (a.nextAttemptAt?.toISOString() ?? null) : null,
            error: a.error,
            finishedAt: a.finishedAt?.toISOString() ?? null,
            canRetry: r.status !== 'TEST' && a.type === 'WEBHOOK' && a.status === 'FAILED' && a.attempts < MAX_TOTAL_ATTEMPTS,
          };
        }),
        testedBy: r.testedById ? (users.get(r.testedById) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      };
    });
  }

  // ------------------------------------------------------------------ testing and retrying

  /**
   * A dry run on a real event that already happened (the most recent one the trigger
   * listens to, or the one given). Shows the facts, which conditions pass and what each
   * action would do. Nothing is created. Webhooks are sent only when asked, marked as a test.
   */
  async test(org: OrgContext, actor: Actor, id: string, input: { eventId?: string; sendWebhooks: boolean }) {
    const w = await this.prisma.workflow.findFirst({ where: { id, orgId: org.id }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!w) throw new NotFoundException('Workflow not found');
    const v = w.versions[0];
    const def = triggerDef(v.trigger);
    const conditions = v.conditions as unknown as Condition[];
    const actions = v.actions as unknown as WorkflowAction[];

    const sample = await this.prisma.$transaction(async (tx) => {
      const where: Prisma.AuditEventWhereInput = { orgId: org.id, action: { in: [...def.auditActions] }, ...(input.eventId ? { id: BigInt(input.eventId) } : {}) };
      const events = await tx.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take: input.eventId ? 1 : TEST_LOOKBACK, select: { id: true, action: true, entityType: true, entityId: true, createdAt: true } });
      for (const e of events) {
        const facts = await loadEventFacts(tx, org.id, e);
        if (facts && facts.trigger === v.trigger) {
          const previews = await Promise.all(actions.map((a) => (a.type === 'CREATE_TASK' ? this.runner.previewTask(tx, org.id, a, facts.facts, e.createdAt) : null)));
          return { e, facts, previews };
        }
      }
      return null;
    });
    if (!sample) {
      throw new DomainError(
        'NO_SAMPLE_EVENT',
        input.eventId ? 'That event is not one this workflow listens to' : `Nothing has happened yet that this workflow listens to (${def.label.toLowerCase()}). Make one happen, then test again.`,
        HttpStatus.NOT_FOUND,
      );
    }
    const { e, facts, previews } = sample;
    const result = evaluateConditions(v.trigger as WorkflowTrigger, conditions, facts.facts);
    const now = new Date();
    const runId = randomUUID();
    const actionRows: Prisma.WorkflowActionRunCreateManyInput[] = [];
    for (const [position, a] of actions.entries()) {
      if (a.type === 'CREATE_TASK') {
        actionRows.push({ orgId: org.id, runId, position, type: a.type, status: 'SKIPPED', input: previews[position] as unknown as Prisma.InputJsonValue, finishedAt: now });
        continue;
      }
      const deliveryId = randomUUID();
      if (!input.sendWebhooks || !result.matched) {
        actionRows.push({ id: deliveryId, orgId: org.id, runId, position, type: a.type, status: 'SKIPPED', input: { url: a.url }, finishedAt: now });
        continue;
      }
      const body = this.runner.webhookBody({ deliveryId, orgId: org.id, trigger: v.trigger, occurredAt: now, test: true, workflow: { id: w.id, name: w.name, version: v.version }, entityType: facts.entityType, entityId: facts.entityId, facts: facts.facts });
      const res = await this.runner.send(w.signingSecret, a.url, deliveryId, v.trigger, 1, body);
      const attempt: Attempt = { at: new Date().toISOString(), status: res.status, ok: res.ok, durationMs: res.durationMs, error: res.error, responseSnippet: res.responseSnippet };
      actionRows.push({ id: deliveryId, orgId: org.id, runId, position, type: a.type, status: res.ok ? 'SUCCEEDED' : 'FAILED', input: { url: a.url }, result: { test: attempt } as unknown as Prisma.InputJsonValue, attempts: 1, error: res.ok ? null : (res.error ?? 'Delivery failed'), finishedAt: new Date() });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workflowRun.create({
        data: {
          id: runId,
          orgId: org.id,
          workflowId: w.id,
          version: v.version,
          trigger: v.trigger,
          eventId: e.id,
          entityType: facts.entityType,
          entityId: facts.entityId,
          facts: { ...facts.facts, _link: facts.link } as Prisma.InputJsonValue,
          conditions: result.results as unknown as Prisma.InputJsonValue,
          status: 'TEST',
          testedById: actor.id,
          finishedAt: now,
        },
      });
      await tx.workflowActionRun.createMany({ data: actionRows });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'workflow.tested', entityType: 'workflow', entityId: w.id, data: { runId, eventId: e.id.toString(), matched: result.matched, webhooksSent: actionRows.filter((r) => r.status !== 'SKIPPED' && r.type === 'WEBHOOK').length } });
    });
    return { matched: result.matched, run: await this.run(org.id, runId) };
  }

  /** Sends a failed webhook once more, now. */
  async retry(org: OrgContext, actor: Actor, runId: string, position: number) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workflow_runs WHERE id = ${runId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const run = await tx.workflowRun.findFirst({ where: { id: runId, orgId: org.id }, include: { actions: { where: { position } } } });
      const a = run?.actions[0];
      if (!run || !a) throw new NotFoundException('Run or action not found');
      if (run.status === 'TEST') throw new DomainError('TEST_RUN', 'A test run cannot be retried; test the workflow again instead', HttpStatus.CONFLICT);
      if (a.type !== 'WEBHOOK' || a.status !== 'FAILED') throw new DomainError('NOT_FAILED', 'Only a failed webhook can be retried', HttpStatus.CONFLICT);
      if (a.attempts >= MAX_TOTAL_ATTEMPTS) throw new DomainError('TOO_MANY_ATTEMPTS', `This webhook has been tried ${a.attempts} times. Check the receiving end, then test the workflow.`, HttpStatus.CONFLICT);
      if (run.status === 'FAILED') await tx.workflowRun.update({ where: { id: runId }, data: { status: 'RUNNING', error: null, finishedAt: null } });
      await tx.workflowActionRun.update({ where: { id: a.id }, data: { status: 'PENDING', nextAttemptAt: new Date(), lockedUntil: null, finishedAt: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'workflow.action_retried', entityType: 'workflow_run', entityId: runId, data: { workflowId: run.workflowId, position, attempts: a.attempts } });
    });
    return this.run(org.id, runId);
  }
}
