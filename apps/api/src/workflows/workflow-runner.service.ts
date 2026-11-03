import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  Condition,
  CreateTaskAction,
  dueDateWindow,
  evaluateConditions,
  Facts,
  formatAmountText,
  formatDateText,
  istDate,
  latestOccurrence,
  nextDeliveryAttempt,
  nextWebhookAttempt,
  renderTemplate,
  SendEmailAction,
  TriggerParams,
  triggerDef,
  WorkflowAction,
  WorkflowTrigger,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { addDays, ROLE_LABELS, TasksService, todayIst } from '../tasks/tasks.service';
import { EMAIL_NOT_SET_UP, MailerService } from './email';
import { sendWebhook, signPayload, WebhookResult } from './webhook';
import { dueDocuments, EventFacts, loadDueDocumentFacts, loadEventFacts, loadScheduleFacts, WATCHED_ACTIONS } from './workflow-facts';

/** Events read for one organisation in one transaction. */
const EVENT_BATCH = 200;
/** Webhooks sent in one pass. */
const DELIVERY_BATCH = 20;
/** How long a claimed delivery is reserved for the worker sending it. */
const CLAIM_SECONDS = 120;
/** Attempts kept in an action's log. */
const HISTORY_KEPT = 10;
/** Invoices or bills one date-trigger workflow acts on in one pass. */
const DUE_BATCH = 200;
/** Most addresses one email goes to. */
const MAX_RECIPIENTS = 50;

export interface EmailPreview {
  to: string[];
  /** Who the email is for, in words: "Accountants", a member's name, or the customer. */
  recipientLabel: string;
  subject: string;
  body: string;
  /** Why it cannot be sent (no address), or null. */
  problem: string | null;
}

/** Where a live run came from: an audit event, or an occurrence of a schedule trigger. */
type RunSource = { eventId: bigint } | { occurrenceKey: string };

export interface TaskPreview {
  title: string;
  description: string | null;
  assignTo: { role: string } | { userId: string };
  assigneeLabel: string;
  dueDate: string | null;
}

export interface Attempt {
  at: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
  responseSnippet: string | null;
}

type WorkflowWithVersion = Prisma.WorkflowGetPayload<{ include: { versions: true } }>;

/**
 * Runs workflows. Business events are read from the audit trail, which is written in the
 * same transaction as the change it records, so an event is seen exactly when its change
 * is committed (a transactional outbox). Each organisation has a cursor: the last audit
 * event looked at. The cursor row is locked while a batch is handled, so two API processes
 * never handle the same events, and each live run is unique per workflow and event.
 *
 * Tasks are created in the same transaction as the run. Webhooks are queued as pending
 * actions and sent afterwards, with retries on a fixed schedule.
 */
@Injectable()
export class WorkflowRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Workflows');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<{ runs: number; deliveries: number }> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly mailer: MailerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.WORKFLOW_RUNNER_INTERVAL_SECONDS;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error(`Workflow runner failed: ${(e as Error).message}`)), every * 1000);
      this.timer.unref();
      this.logger.log(`Workflow runner looks for events, schedules and due deliveries every ${every} s; email goes through each organisation's own mail server (Settings → Integrations)${this.config.SMTP_URL ? ', or the server\'s SMTP_URL' : ''}`);
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  /**
   * One pass: handle new events, then schedules that have come round, then send due webhooks
   * and emails. Overlapping calls share one pass. `now` is for tests: schedules are judged
   * against it (deliveries always use the database clock).
   */
  tick(opts: { now?: Date } = {}): Promise<{ runs: number; deliveries: number }> {
    if (!this.inFlight) {
      this.inFlight = (async () => {
        const runs = (await this.processEvents()) + (await this.processSchedules(opts.now ?? new Date()));
        const deliveries = await this.deliverDue();
        return { runs, deliveries };
      })().finally(() => (this.inFlight = null));
    }
    return this.inFlight;
  }

  // ------------------------------------------------------------------ events

  async processEvents(): Promise<number> {
    // A Prisma query runs when awaited, so it is awaited inside the context it needs.
    const orgs = await this.orgsWithEnabled('event');
    let runs = 0;
    for (const orgId of orgs) {
      try {
        for (;;) {
          const r = await tenantStorage.run({ orgId }, () => this.processOrgBatch(orgId));
          runs += r.runs;
          if (!r.more) break;
        }
      } catch (e) {
        this.logger.error(`Workflows for organisation ${orgId} failed: ${(e as Error).message}`);
      }
    }
    return runs;
  }

  private async processOrgBatch(orgId: string): Promise<{ runs: number; more: boolean }> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`INSERT INTO workflow_cursors (org_id, last_event_id, updated_at) VALUES (${orgId}::uuid, 0, now()) ON CONFLICT (org_id) DO NOTHING`;
        const cur = await tx.$queryRaw<{ last_event_id: bigint }[]>`SELECT last_event_id FROM workflow_cursors WHERE org_id = ${orgId}::uuid FOR UPDATE SKIP LOCKED`;
        if (!cur.length) return { runs: 0, more: false }; // another process has this organisation
        const workflows = (await this.enabledWorkflows(tx, orgId)).filter((w) => triggerDef(w.versions[0].trigger).kind === 'event');
        if (!workflows.length) return { runs: 0, more: false };
        // Nothing before the earliest "turned on" point can start a run, so skip straight past it.
        const earliest = workflows.reduce((m, w) => (w.activeFromEventId! < m ? w.activeFromEventId! : m), workflows[0].activeFromEventId!);
        const from = cur[0].last_event_id > earliest ? cur[0].last_event_id : earliest;
        // Audit ids are committed in order within an organisation (appends hold a per-organisation
        // lock until commit), so every event up to the highest visible id is already visible.
        const hi = (await tx.auditEvent.aggregate({ where: { orgId }, _max: { id: true } }))._max.id ?? from;
        const events = await tx.auditEvent.findMany({
          where: { orgId, id: { gt: from, lte: hi }, action: { in: WATCHED_ACTIONS } },
          orderBy: { id: 'asc' },
          take: EVENT_BATCH,
          select: { id: true, action: true, entityType: true, entityId: true, createdAt: true },
        });
        let runs = 0;
        for (const e of events) {
          const listening = workflows.filter((w) => w.activeFromEventId! < e.id && this.listensTo(w, e.action));
          if (!listening.length) continue;
          const facts = await loadEventFacts(tx, orgId, e);
          if (!facts) continue;
          for (const w of listening) {
            if (w.versions[0].trigger !== facts.trigger) continue;
            await this.startRun(tx, orgId, w, { eventId: e.id }, facts, e.createdAt);
            runs++;
          }
        }
        const more = events.length === EVENT_BATCH;
        const next = more ? events[events.length - 1].id : hi > from ? hi : from;
        await tx.workflowCursor.update({ where: { orgId }, data: { lastEventId: next } });
        return { runs, more };
      },
      { timeout: 60_000 },
    );
  }

  /** Organisations with at least one workflow on whose trigger is of this kind. */
  private async orgsWithEnabled(kind: 'event' | 'schedule'): Promise<string[]> {
    // A Prisma query runs when awaited, so it is awaited inside the context it needs.
    const rows = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.workflow.findMany({ where: { enabled: true }, select: { orgId: true, currentVersion: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { trigger: true } } } }),
    );
    return [...new Set(rows.filter((r) => r.versions[0] && triggerDef(r.versions[0].trigger).kind === kind).map((r) => r.orgId))];
  }

  // ------------------------------------------------------------------ schedules

  /**
   * Schedule triggers. SCHEDULE acts once on each time its schedule comes round; the date
   * triggers act once per invoice or bill on the day it reaches the set number of days. Only
   * times and dates from when the workflow was turned on count, so turning one on never
   * sends a backlog. A per-organisation advisory lock keeps two API processes apart, and a
   * unique index on (workflow, occurrence) makes each act at most once.
   */
  async processSchedules(now: Date): Promise<number> {
    let runs = 0;
    for (const orgId of await this.orgsWithEnabled('schedule')) {
      try {
        runs += await tenantStorage.run({ orgId }, () => this.scheduleOrg(orgId, now));
      } catch (e) {
        this.logger.error(`Scheduled workflows for organisation ${orgId} failed: ${(e as Error).message}`);
      }
    }
    return runs;
  }

  private async scheduleOrg(orgId: string, now: Date): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${'workflow-schedule:' + orgId})) AS ok`;
        if (!lock.ok) return 0; // another process has this organisation
        const workflows = (await this.enabledWorkflows(tx, orgId)).filter((w) => triggerDef(w.versions[0].trigger).kind === 'schedule' && w.activatedAt);
        const today = istDate(now);
        let runs = 0;
        for (const w of workflows) {
          const v = w.versions[0];
          const params = v.triggerParams as TriggerParams;
          if (v.trigger === 'SCHEDULE') {
            const occ = latestOccurrence(params, now);
            if (occ.at < w.activatedAt!) continue;
            const key = `at:${occ.at.toISOString()}`;
            if (await tx.workflowRun.findFirst({ where: { workflowId: w.id, occurrenceKey: key, status: { not: 'TEST' } }, select: { id: true } })) continue;
            await this.startRun(tx, orgId, w, { occurrenceKey: key }, await loadScheduleFacts(tx, orgId, occ.date), occ.at);
            runs++;
            continue;
          }
          const trigger = v.trigger as 'INVOICE_OVERDUE' | 'BILL_DUE_SOON';
          const days = params.days ?? 0;
          const win = dueDateWindow(trigger, days, istDate(w.activatedAt!), today);
          const suffix = `:${days}`;
          const ids = await dueDocuments(tx, orgId, { kind: trigger === 'INVOICE_OVERDUE' ? 'INVOICE' : 'BILL', from: win.from, to: win.to, asOf: today, workflowId: w.id, keyPrefix: 'doc:', keySuffix: suffix, limit: DUE_BATCH });
          for (const id of ids) {
            const facts = await loadDueDocumentFacts(tx, orgId, trigger, id, today);
            if (!facts) continue;
            await this.startRun(tx, orgId, w, { occurrenceKey: `doc:${id}${suffix}` }, facts, now);
            runs++;
          }
        }
        return runs;
      },
      { timeout: 60_000 },
    );
  }

  private async enabledWorkflows(tx: Tx, orgId: string): Promise<WorkflowWithVersion[]> {
    const list = await tx.workflow.findMany({ where: { orgId, enabled: true }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    return list.filter((w) => w.versions.length && w.versions[0].version === w.currentVersion && w.activeFromEventId !== null);
  }
  private listensTo(w: WorkflowWithVersion, action: string) {
    return triggerDef(w.versions[0].trigger).auditActions.includes(action);
  }

  /** What a task action would create for these facts. */
  async previewTask(tx: Tx, orgId: string, a: CreateTaskAction, facts: Facts, eventDate: Date): Promise<TaskPreview> {
    const title = renderTemplate(a.title, facts).slice(0, 200);
    const description = a.description ? renderTemplate(a.description, facts).slice(0, 2000) : null;
    let assigneeLabel: string;
    if ('role' in a.assignTo) assigneeLabel = ROLE_LABELS[a.assignTo.role] ?? a.assignTo.role;
    else assigneeLabel = (await this.tasks.assignableMember(tx, orgId, a.assignTo.userId))?.user.name ?? 'Someone no longer in the organisation';
    return { title, description, assignTo: a.assignTo, assigneeLabel, dueDate: a.dueInDays === null ? null : addDays(todayIst(eventDate), a.dueInDays) };
  }

  /**
   * What an email action would send for these facts: the addresses, and the subject and body
   * with amounts and dates written for people. Emails to members end with a link to the
   * record; emails to a customer or vendor do not.
   */
  async previewEmail(tx: Tx, orgId: string, workflowName: string, a: SendEmailAction, ev: EventFacts): Promise<EmailPreview> {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, functionalCurrency: true } });
    const types = new Map(triggerDef(ev.trigger).facts.map((f) => [f.key, f.type]));
    const format = (key: string, value: string) => (types.get(key) === 'money' ? formatAmountText(value, org.functionalCurrency) : types.get(key) === 'date' ? formatDateText(value) : value);
    const subject = renderTemplate(a.subject, ev.facts, format).replace(/[\r\n]+/g, ' ').slice(0, 200);
    let body = renderTemplate(a.body, ev.facts, format).slice(0, 5000);
    let to: string[] = [];
    let recipientLabel: string;
    let problem: string | null = null;
    if ('contact' in a.to) {
      recipientLabel = ev.facts.contactName ?? 'The customer or vendor';
      const email = (ev.facts.contactEmail ?? '').trim();
      if (email) to = [email];
      else problem = `${recipientLabel} has no email address`;
      body += `\n\n--\nSent by ${org.name}.`;
    } else {
      if ('role' in a.to) {
        recipientLabel = ROLE_LABELS[a.to.role] ?? a.to.role;
        const members = await tx.membership.findMany({ where: { orgId, role: a.to.role as never }, select: { user: { select: { email: true } } }, orderBy: { createdAt: 'asc' } });
        to = members.map((m) => m.user.email);
        if (!to.length) problem = `No one in the organisation is in ${recipientLabel.toLowerCase()}`;
      } else {
        const m = await tx.membership.findFirst({ where: { orgId, userId: a.to.userId }, select: { user: { select: { name: true, email: true } } } });
        recipientLabel = m?.user.name ?? 'Someone no longer in the organisation';
        if (m) to = [m.user.email];
        else problem = 'That person is no longer in the organisation';
      }
      const link = ev.link ? (await this.tasks.linkPaths(tx, [ev.link]))(ev.link) : null;
      const base = this.config.APP_URL.replace(/\/+$/, '');
      body += `\n\n--\nSent by the automation "${workflowName}" in Talk2Tax for ${org.name}.${link ? `\n${link.label}: ${base}/orgs/${orgId}${link.path}` : ''}`;
    }
    to = [...new Set(to.map((x) => x.toLowerCase()))];
    if (to.length > MAX_RECIPIENTS) {
      problem = `${to.length} addresses is more than ${MAX_RECIPIENTS}`;
      to = to.slice(0, MAX_RECIPIENTS);
    }
    return { to, recipientLabel, subject, body, problem };
  }

  /** Records a live run: conditions, then each action. Tasks are created here; webhooks and emails are queued. */
  private async startRun(tx: Tx, orgId: string, w: WorkflowWithVersion, source: RunSource, ev: EventFacts, eventDate: Date) {
    const v = w.versions[0];
    const conditions = v.conditions as unknown as Condition[];
    const actions = v.actions as unknown as WorkflowAction[];
    const result = evaluateConditions(v.trigger as WorkflowTrigger, conditions, ev.facts);
    const now = new Date();
    const run = await tx.workflowRun.create({
      data: {
        orgId,
        workflowId: w.id,
        version: v.version,
        trigger: v.trigger,
        ...('eventId' in source ? { eventId: source.eventId } : { occurrenceKey: source.occurrenceKey }),
        entityType: ev.entityType,
        entityId: ev.entityId,
        facts: (ev.link ? { ...ev.facts, _link: ev.link } : ev.facts) as Prisma.InputJsonValue,
        conditions: result.results as unknown as Prisma.InputJsonValue,
        status: result.matched ? 'RUNNING' : 'SKIPPED',
        finishedAt: result.matched ? null : now,
      },
    });
    if (!result.matched) return;
    for (const [position, a] of actions.entries()) {
      if (a.type === 'CREATE_TASK') {
        const preview = await this.previewTask(tx, orgId, a, ev.facts, eventDate);
        try {
          const task = await this.tasks.createInTx(tx, orgId, { title: preview.title, description: preview.description, assignTo: a.assignTo, dueDate: preview.dueDate, link: ev.link, workflowRunId: run.id, createdById: null });
          await tx.workflowActionRun.create({ data: { orgId, runId: run.id, position, type: a.type, status: 'SUCCEEDED', input: preview as unknown as Prisma.InputJsonValue, result: { taskId: task.id }, attempts: 1, finishedAt: now } });
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          await tx.workflowActionRun.create({ data: { orgId, runId: run.id, position, type: a.type, status: 'FAILED', input: preview as unknown as Prisma.InputJsonValue, attempts: 1, error: e.message, finishedAt: now } });
        }
      } else if (a.type === 'SEND_EMAIL') {
        const preview = await this.previewEmail(tx, orgId, w.name, a, ev);
        const problem = preview.problem ?? ((await this.mailer.status(orgId)).ready ? null : EMAIL_NOT_SET_UP);
        await tx.workflowActionRun.create({
          data: problem
            ? { orgId, runId: run.id, position, type: a.type, status: 'FAILED', input: preview as unknown as Prisma.InputJsonValue, attempts: 0, error: problem, finishedAt: now }
            : { orgId, runId: run.id, position, type: a.type, status: 'PENDING', input: preview as unknown as Prisma.InputJsonValue, nextAttemptAt: now },
        });
      } else {
        await tx.workflowActionRun.create({ data: { orgId, runId: run.id, position, type: a.type, status: 'PENDING', input: { url: a.url }, nextAttemptAt: now } });
      }
    }
    await this.finishRunIfDone(tx, run.id);
  }

  /** A run is finished when none of its actions is still pending: failed if any failed. */
  async finishRunIfDone(tx: Tx, runId: string) {
    const actions = await tx.workflowActionRun.findMany({ where: { runId }, orderBy: { position: 'asc' }, select: { position: true, status: true, error: true } });
    if (actions.some((a) => a.status === 'PENDING')) return;
    const failed = actions.find((a) => a.status === 'FAILED');
    await tx.workflowRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: failed ? 'FAILED' : 'SUCCEEDED', error: failed ? `Action ${failed.position + 1}: ${failed.error ?? 'failed'}`.slice(0, 1000) : null, finishedAt: new Date() },
    });
  }

  // ------------------------------------------------------------------ webhooks

  /** The JSON a webhook receives. The same bytes are sent on every attempt of one delivery. */
  webhookBody(p: { deliveryId: string; orgId: string; trigger: string; occurredAt: Date; test: boolean; workflow: { id: string; name: string; version: number }; entityType: string | null; entityId: string | null; facts: Record<string, unknown> }) {
    const { _link, ...facts } = p.facts;
    void _link;
    return JSON.stringify({
      id: p.deliveryId,
      event: p.trigger,
      test: p.test,
      occurredAt: p.occurredAt.toISOString(),
      organizationId: p.orgId,
      workflow: p.workflow,
      entity: p.entityType && p.entityId ? { type: p.entityType, id: p.entityId } : null,
      data: facts,
    });
  }

  async send(secret: string, url: string, deliveryId: string, trigger: string, attempt: number, body: string): Promise<WebhookResult> {
    return sendWebhook(
      url,
      body,
      { 't2t-signature': signPayload(secret, body), 't2t-event': trigger, 't2t-delivery': deliveryId, 't2t-attempt': String(attempt) },
      { allowPrivateNetworks: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS, timeoutMs: this.config.WEBHOOK_TIMEOUT_SECONDS * 1000 },
    );
  }

  /** Claims webhooks and emails that are due and sends them. Returns how many were attempted. */
  async deliverDue(): Promise<number> {
    const claimed = await tenantStorage.run({ bypass: true }, async () =>
      this.prisma.$transaction(
        (tx) => tx.$queryRaw<{ id: string; org_id: string }[]>`
          UPDATE workflow_action_runs SET locked_until = now() + make_interval(secs => ${CLAIM_SECONDS})
          WHERE id IN (
            SELECT id FROM workflow_action_runs
            WHERE status = 'PENDING' AND type IN ('WEBHOOK', 'SEND_EMAIL') AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
            ORDER BY next_attempt_at LIMIT ${DELIVERY_BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING id, org_id`,
      ),
    );
    for (const c of claimed) {
      try {
        await tenantStorage.run({ orgId: c.org_id }, () => this.deliverOne(c.org_id, c.id));
      } catch (e) {
        this.logger.error(`Delivery ${c.id} failed to record: ${(e as Error).message}`);
      }
    }
    return claimed.length;
  }

  private async deliverOne(orgId: string, actionRunId: string) {
    const a = await this.prisma.workflowActionRun.findFirst({ where: { id: actionRunId, orgId }, include: { run: { include: { workflow: { select: { id: true, name: true, signingSecret: true } } } } } });
    if (!a || a.status !== 'PENDING') return;
    const attempt = a.attempts + 1;
    if (a.type === 'SEND_EMAIL') {
      const e = a.input as unknown as EmailPreview;
      const res = await this.mailer.send(orgId, { to: e.to, subject: e.subject, text: e.body, messageId: `<${a.id}@talk2tax.workflow>`, headers: { 'X-T2T-Workflow': a.run.workflow.id, 'X-T2T-Attempt': String(attempt) } });
      const now = new Date();
      await this.recordAttempt(a.id, a.runId, attempt, { status: res.status, ok: res.ok, durationMs: res.durationMs, error: res.error, responseSnippet: res.responseSnippet }, res.ok ? null : nextDeliveryAttempt(attempt, res.retryable, now), now);
      return;
    }
    const body = this.webhookBody({
      deliveryId: a.id,
      orgId,
      trigger: a.run.trigger,
      occurredAt: a.run.createdAt,
      test: false,
      workflow: { id: a.run.workflow.id, name: a.run.workflow.name, version: a.run.version },
      entityType: a.run.entityType,
      entityId: a.run.entityId,
      facts: a.run.facts as Record<string, unknown>,
    });
    const res = await this.send(a.run.workflow.signingSecret, (a.input as { url: string }).url, a.id, a.run.trigger, attempt, body);
    const now = new Date();
    await this.recordAttempt(a.id, a.runId, attempt, { status: res.status, ok: res.ok, durationMs: res.durationMs, error: res.error, responseSnippet: res.responseSnippet }, res.ok ? null : nextWebhookAttempt(attempt, res.status, now), now);
  }

  /** Records one delivery attempt: done, waiting for the next try, or failed for good. */
  private async recordAttempt(id: string, runId: string, attempt: number, res: Omit<Attempt, 'at'>, next: Date | null, now: Date) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workflow_action_runs WHERE id = ${id}::uuid FOR UPDATE`;
      const fresh = await tx.workflowActionRun.findUniqueOrThrow({ where: { id } });
      if (fresh.status !== 'PENDING') return;
      const history = [...(((fresh.result as { attempts?: Attempt[] }).attempts ?? []) as Attempt[]), { at: now.toISOString(), ...res }].slice(-HISTORY_KEPT);
      await tx.workflowActionRun.update({
        where: { id },
        data: {
          attempts: attempt,
          result: { attempts: history } as unknown as Prisma.InputJsonValue,
          lockedUntil: null,
          ...(res.ok
            ? { status: 'SUCCEEDED', error: null, nextAttemptAt: null, finishedAt: now }
            : next
              ? { error: res.error, nextAttemptAt: next }
              : { status: 'FAILED', error: res.error ?? 'Delivery failed', nextAttemptAt: null, finishedAt: now }),
        },
      });
      await this.finishRunIfDone(tx, runId);
    });
  }
}
