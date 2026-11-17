import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AssignableRole } from '@talk2tax/accounting-engine';
import { Prisma, TaskStatus } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import type { LinkType } from '../workflows/workflow-facts';
import { lockRow } from '../db/locks';

type Actor = { id: string };
export type Assignee = { role: AssignableRole } | { userId: string };

export const ROLE_LABELS: Record<string, string> = { OWNER: 'Owners', ADMIN: 'Admins', ACCOUNTANT: 'Accountants', APPROVER: 'Approvers', VIEWER: 'Viewers' };

export interface NewTask {
  title: string;
  description?: string | null;
  assignTo: Assignee;
  dueDate: string | null;
  link?: { type: LinkType; id: string } | null;
  workflowRunId?: string | null;
  createdById: string | null;
  /** Where the task came from; a person when not given. */
  source?: TaskSource;
}

export const TASK_SOURCES = ['PERSON', 'WORKFLOW', 'AI_AGENT', 'ALERT', 'CLOSE'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
export const SOURCE_LABELS: Record<TaskSource, string> = { PERSON: 'A person', WORKFLOW: 'An automation', AI_AGENT: 'The AI assistant', ALERT: 'An alert', CLOSE: 'Month-end close' };

type TaskRow = Prisma.TaskGetPayload<object>;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Whether a user is a member who can be given tasks. */
  async assignableMember(tx: Tx, orgId: string, userId: string) {
    const m = await tx.membership.findFirst({ where: { orgId, userId }, select: { role: true, user: { select: { name: true } } } });
    return m && hasPermission(m.role as RoleName, 'tasks.use') ? m : null;
  }

  /** Creates a task inside the caller's transaction (used by people and by workflows). */
  async createInTx(tx: Tx, orgId: string, t: NewTask) {
    if ('userId' in t.assignTo && !(await this.assignableMember(tx, orgId, t.assignTo.userId))) {
      throw new DomainError('ASSIGNEE_NOT_MEMBER', 'The person this task is for is not a member who can work on tasks', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const task = await tx.task.create({
      data: {
        orgId,
        title: t.title.slice(0, 200),
        description: t.description ? t.description.slice(0, 2000) : null,
        assigneeUserId: 'userId' in t.assignTo ? t.assignTo.userId : null,
        assigneeRole: 'role' in t.assignTo ? t.assignTo.role : null,
        dueDate: t.dueDate ? toDbDate(t.dueDate) : null,
        linkType: t.link?.type ?? null,
        linkId: t.link?.id ?? null,
        workflowRunId: t.workflowRunId ?? null,
        source: t.source ?? (t.workflowRunId ? 'WORKFLOW' : 'PERSON'),
        createdById: t.createdById,
      },
    });
    await this.audit.append(tx, {
      orgId,
      actorId: t.createdById,
      action: 'task.created',
      entityType: 'task',
      entityId: task.id,
      data: { title: task.title, assigneeUserId: task.assigneeUserId, assigneeRole: task.assigneeRole, dueDate: t.dueDate, workflowRunId: task.workflowRunId, source: task.source },
    });
    return task;
  }

  async create(org: OrgContext, actor: Actor, input: { title: string; description?: string | null; assignTo: Assignee; dueDate: string | null }) {
    const id = await this.prisma.$transaction(async (tx) => (await this.createInTx(tx, org.id, { ...input, createdById: actor.id })).id);
    return this.get(org, actor, id);
  }

  private canManage(org: OrgContext) {
    return hasPermission(org.role, 'workflows.manage');
  }
  /** A member sees tasks given to them or to their role, and those they created; managers see all. */
  private visibleWhere(org: OrgContext, actor: Actor): Prisma.TaskWhereInput {
    if (this.canManage(org)) return { orgId: org.id };
    return { orgId: org.id, OR: [{ assigneeUserId: actor.id }, { assigneeRole: org.role }, { createdById: actor.id }] };
  }
  private mineWhere(org: OrgContext, actor: Actor): Prisma.TaskWhereInput {
    return { orgId: org.id, OR: [{ assigneeUserId: actor.id }, { assigneeRole: org.role }] };
  }

  async list(org: OrgContext, actor: Actor, q: { scope: 'mine' | 'all'; status: TaskStatus | 'ALL'; source?: TaskSource | 'ALL' }) {
    if (q.scope === 'all' && !this.canManage(org)) {
      throw new DomainError('FORBIDDEN', 'Only owners and admins can see every task', HttpStatus.FORBIDDEN);
    }
    const base = q.scope === 'mine' ? this.mineWhere(org, actor) : this.visibleWhere(org, actor);
    const where: Prisma.TaskWhereInput = { AND: [base, q.status === 'ALL' ? {} : { status: q.status }, !q.source || q.source === 'ALL' ? {} : { source: q.source }] };
    const [rows, open, overdue] = await Promise.all([
      this.prisma.task.findMany({ where, orderBy: q.status === 'OPEN' ? [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] : [{ createdAt: 'desc' }], take: 500 }),
      this.prisma.task.count({ where: { AND: [this.mineWhere(org, actor), { status: 'OPEN' }] } }),
      this.prisma.task.count({ where: { AND: [this.mineWhere(org, actor), { status: 'OPEN', dueDate: { lt: toDbDate(todayIst()) } }] } }),
    ]);
    return { counts: { mineOpen: open, mineOverdue: overdue }, tasks: await this.serializeMany(org, actor, rows) };
  }

  /** Open tasks for the current member (for the navigation badge). */
  async count(org: OrgContext, actor: Actor) {
    return { open: await this.prisma.task.count({ where: { AND: [this.mineWhere(org, actor), { status: 'OPEN' }] } }) };
  }

  async get(org: OrgContext, actor: Actor, id: string) {
    const t = await this.prisma.task.findFirst({ where: { AND: [{ id }, this.visibleWhere(org, actor)] } });
    if (!t) throw new NotFoundException('Task not found');
    return (await this.serializeMany(org, actor, [t]))[0];
  }

  async close(org: OrgContext, actor: Actor, id: string, to: 'DONE' | 'CANCELLED', note: string | null) {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'tasks', id);
      const t = await tx.task.findFirst({ where: { AND: [{ id }, this.visibleWhere(org, actor)] } });
      if (!t) throw new NotFoundException('Task not found');
      if (t.status !== 'OPEN') throw new DomainError('TASK_CLOSED', `This task is already ${t.status === 'DONE' ? 'done' : 'cancelled'}`, HttpStatus.CONFLICT);
      if (!this.mayWork(org, actor, t)) throw new DomainError('FORBIDDEN', 'Only the person the task is for, its creator, or an owner or admin can close it', HttpStatus.FORBIDDEN);
      await tx.task.update({ where: { id }, data: { status: to, closedById: actor.id, closedAt: new Date(), closeNote: note } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: to === 'DONE' ? 'task.completed' : 'task.cancelled', entityType: 'task', entityId: id, data: { title: t.title, note } });
    });
    return this.get(org, actor, id);
  }

  private mayWork(org: OrgContext, actor: Actor, t: TaskRow) {
    return this.canManage(org) || t.assigneeUserId === actor.id || t.assigneeRole === org.role || t.createdById === actor.id;
  }

  /** Where in the app a task's record is shown. */
  async linkPaths(tx: Pick<PrismaService, 'document' | 'payment'>, links: { type: string | null; id: string | null }[]) {
    const docIds = links.filter((l) => l.type === 'DOCUMENT' && l.id).map((l) => l.id!);
    const payIds = links.filter((l) => l.type === 'PAYMENT' && l.id).map((l) => l.id!);
    const [docs, pays] = await Promise.all([
      docIds.length ? tx.document.findMany({ where: { id: { in: docIds } }, select: { id: true, kind: true, number: true } }) : [],
      payIds.length ? tx.payment.findMany({ where: { id: { in: payIds } }, select: { id: true, kind: true, number: true } }) : [],
    ]);
    const docBy = new Map(docs.map((d) => [d.id, d]));
    const payBy = new Map(pays.map((p) => [p.id, p]));
    return (l: { type: string | null; id: string | null }): { path: string; label: string } | null => {
      if (!l.type || !l.id) return null;
      if (l.type === 'DOCUMENT') {
        const d = docBy.get(l.id);
        if (!d) return null;
        const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
        return { path: `/${sales ? 'sales/invoices' : 'purchases/bills'}/${d.id}`, label: `${{ INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit' }[d.kind]} ${d.number ?? '(draft)'}` };
      }
      if (l.type === 'PAYMENT') {
        const p = payBy.get(l.id);
        if (!p) return null;
        return { path: `/${p.kind === 'RECEIPT' ? 'sales/receipts' : 'purchases/payments'}/${p.id}`, label: `${p.kind === 'RECEIPT' ? 'Receipt' : 'Payment'} ${p.number}` };
      }
      if (l.type === 'JOURNAL') return { path: `/journals/${l.id}`, label: 'Journal entry' };
      if (l.type === 'EXPENSE_CLAIM') return { path: `/expenses/${l.id}`, label: 'Expense claim' };
      if (l.type === 'ALERT') return { path: `/alerts?alert=${l.id}`, label: 'Alert' };
      if (l.type === 'PERIOD_CLOSE') return { path: `/close/${l.id}`, label: 'Month-end close' };
      return null;
    };
  }

  private async serializeMany(org: OrgContext, actor: Actor, rows: TaskRow[]) {
    const ids = [...new Set(rows.flatMap((t) => [t.assigneeUserId, t.createdById, t.closedById]).filter((x): x is string => !!x))];
    const users = new Map((ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    const runIds = [...new Set(rows.map((t) => t.workflowRunId).filter((x): x is string => !!x))];
    const runs = new Map(
      (runIds.length ? await this.prisma.workflowRun.findMany({ where: { id: { in: runIds } }, select: { id: true, workflowId: true, workflow: { select: { name: true } } } }) : []).map((r) => [r.id, r]),
    );
    const path = await this.linkPaths(this.prisma, rows.map((t) => ({ type: t.linkType, id: t.linkId })));
    const today = todayIst();
    return rows.map((t) => {
      const due = t.dueDate ? fromDbDate(t.dueDate) : null;
      const run = t.workflowRunId ? runs.get(t.workflowRunId) : undefined;
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assignee: t.assigneeUserId ? { type: 'user' as const, userId: t.assigneeUserId, label: users.get(t.assigneeUserId) ?? 'Former member' } : { type: 'role' as const, role: t.assigneeRole!, label: ROLE_LABELS[t.assigneeRole!] ?? t.assigneeRole! },
        dueDate: due,
        overdue: t.status === 'OPEN' && due !== null && due < today,
        link: path({ type: t.linkType, id: t.linkId }),
        workflow: run ? { id: run.workflowId, name: run.workflow.name, runId: run.id } : null,
        source: t.source as TaskSource,
        sourceLabel: SOURCE_LABELS[t.source as TaskSource] ?? t.source,
        createdBy: t.createdById ? (users.get(t.createdById) ?? null) : null,
        createdAt: t.createdAt.toISOString(),
        closedBy: t.closedById ? (users.get(t.closedById) ?? null) : null,
        closedAt: t.closedAt?.toISOString() ?? null,
        closeNote: t.closeNote,
        canClose: t.status === 'OPEN' && this.mayWork(org, actor, t),
      };
    });
  }
}

/** Today's date in India time. */
export function todayIst(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
