import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ASSIGNABLE_ROLES, type AssignableRole } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { lockRow } from '../db/locks';

type Actor = { id: string };
type Member = { orgId: string; role: RoleName };

/** How long a proposal waits for the member before it expires. */
export const ACTION_EXPIRY_MINUTES = 15;

export const ACTION_KINDS = ['CREATE_TASK', 'ACKNOWLEDGE_ALERT', 'DISMISS_ALERT'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** What each action needs, and whether it is sensitive (changes something others rely on). */
export const ACTION_RULES: Record<ActionKind, { permission: Permission; sensitive: boolean; label: string }> = {
  CREATE_TASK: { permission: 'tasks.use', sensitive: false, label: 'Create a task' },
  ACKNOWLEDGE_ALERT: { permission: 'alerts.manage', sensitive: false, label: 'Acknowledge an alert' },
  DISMISS_ALERT: { permission: 'alerts.manage', sensitive: true, label: 'Dismiss an alert' },
};

export type ActionInput =
  | { kind: 'CREATE_TASK'; title: string; description: string | null; dueDate: string | null; forRole: AssignableRole | null }
  | { kind: 'ACKNOWLEDGE_ALERT'; alertId: string; note: string | null }
  | { kind: 'DISMISS_ALERT'; alertId: string; reason: string };

export interface ProposalContext {
  orgId: string;
  role: RoleName;
  userId: string;
  conversationId: string;
  answerId: string;
}

const ROLE_WORDS: Record<AssignableRole, string> = { OWNER: 'the owners', ADMIN: 'the admins', ACCOUNTANT: 'the accountants', APPROVER: 'the approvers', VIEWER: 'the viewers' };

/**
 * Actions the assistant can propose but never carry out. A proposal is stored with what it will do
 * in words; only the member who asked can confirm it, on screen, within ACTION_EXPIRY_MINUTES, and
 * their permission is checked again at that moment. Every proposal and decision is audited.
 */
@Injectable()
export class CopilotActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly alerts: AlertsService,
  ) {}

  /** Checks a proposal and stores it. Returns what the model is told. Throws DomainError when it cannot be proposed. */
  async propose(ctx: ProposalContext, input: ActionInput) {
    const rule = ACTION_RULES[input.kind];
    if (!hasPermission(ctx.role, rule.permission)) throw new DomainError('FORBIDDEN', `This member cannot ${rule.label.toLowerCase()}, so it was not proposed`, HttpStatus.FORBIDDEN);
    const summary = await this.describe(ctx.orgId, input);
    const expiresAt = new Date(Date.now() + ACTION_EXPIRY_MINUTES * 60_000);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.copilotAction.create({
        data: { orgId: ctx.orgId, conversationId: ctx.conversationId, messageId: ctx.answerId, userId: ctx.userId, kind: input.kind, input: input as unknown as Prisma.InputJsonValue, summary, sensitive: rule.sensitive, expiresAt },
      });
      await this.audit.append(tx, { orgId: ctx.orgId, actorId: ctx.userId, action: 'copilot.action_proposed', entityType: 'copilot_action', entityId: r.id, data: { kind: input.kind, summary, conversationId: ctx.conversationId } });
      return r;
    });
    return {
      proposed: true,
      done: false,
      summary,
      sensitive: rule.sensitive,
      expiresInMinutes: ACTION_EXPIRY_MINUTES,
      note: `Nothing has been done. A card under your answer asks the member to confirm or cancel; only their confirmation on screen carries this out. Tell them that, and never say it was done.`,
    };
  }

  /** The action in words, checked against the records as they are now. */
  private async describe(orgId: string, input: ActionInput): Promise<string> {
    if (input.kind === 'CREATE_TASK') {
      if (!input.title.trim()) throw new DomainError('INVALID_ACTION', 'A task needs a title');
      if (input.forRole && !(ASSIGNABLE_ROLES as readonly string[]).includes(input.forRole)) throw new DomainError('INVALID_ACTION', 'Unknown role');
      return `Create a task "${input.title.trim().slice(0, 200)}" for ${input.forRole ? ROLE_WORDS[input.forRole] : 'you'}${input.dueDate ? `, due ${input.dueDate}` : ''}.`;
    }
    const a = await this.prisma.alert.findFirst({ where: { id: input.alertId, orgId }, select: { title: true, status: true } });
    if (!a) throw new DomainError('INVALID_ACTION', 'There is no such alert; list the alerts and use an alert_ref from the result');
    if (input.kind === 'ACKNOWLEDGE_ALERT') {
      if (a.status !== 'OPEN') throw new DomainError('INVALID_ACTION', `The alert "${a.title}" is ${a.status.toLowerCase()}; only an open alert can be acknowledged`);
      return `Acknowledge the alert "${a.title}"${input.note ? ` with the note "${input.note}"` : ''}.`;
    }
    if (a.status !== 'OPEN' && a.status !== 'ACKNOWLEDGED') throw new DomainError('INVALID_ACTION', `The alert "${a.title}" is ${a.status.toLowerCase()}; only an open or acknowledged alert can be dismissed`);
    if (!input.reason.trim()) throw new DomainError('INVALID_ACTION', 'Dismissing an alert needs a reason from the member; ask them for it');
    return `Dismiss the alert "${a.title}" as not a problem, with the reason "${input.reason.trim()}". It will stay dismissed even when the checks find it again.`;
  }

  serialize(a: Prisma.CopilotActionGetPayload<object>) {
    const expired = a.status === 'PROPOSED' && a.expiresAt.getTime() <= Date.now();
    return {
      id: a.id,
      messageId: a.messageId,
      kind: a.kind as ActionKind,
      summary: a.summary,
      sensitive: a.sensitive,
      status: expired ? 'EXPIRED' : (a.status as 'PROPOSED' | 'DONE' | 'CANCELLED' | 'FAILED' | 'EXPIRED'),
      result: a.result as { path: string; label: string } | null,
      error: a.error,
      expiresAt: a.expiresAt.toISOString(),
      decidedAt: a.decidedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async forConversation(orgId: string, conversationId: string) {
    const rows = await this.prisma.copilotAction.findMany({ where: { orgId, conversationId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.serialize(r));
  }

  /** Locks a proposal of this member that can still be decided. */
  private async lockOpen(tx: Prisma.TransactionClient, orgId: string, actor: Actor, id: string) {
    await lockRow(tx, 'copilot_actions', id, orgId);
    const a = await tx.copilotAction.findFirst({ where: { id, orgId, userId: actor.id } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Action not found' });
    if (a.status !== 'PROPOSED') throw new DomainError('ACTION_DECIDED', `This action was already ${a.status.toLowerCase()}`, HttpStatus.CONFLICT);
    return a;
  }

  /**
   * The member confirms: the action is carried out now, as them, with their current permissions, in
   * the same transaction that records the decision, so it can never happen twice.
   */
  async confirm(member: Member, actor: Actor, id: string) {
    let failure: { status: 'EXPIRED' | 'FAILED'; error: string; kind: string } | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const a = await this.lockOpen(tx, member.orgId, actor, id);
        const input = a.input as unknown as ActionInput;
        const rule = ACTION_RULES[input.kind];
        if (a.expiresAt.getTime() <= Date.now()) throw new Failure('EXPIRED', `This proposal expired after ${ACTION_EXPIRY_MINUTES} minutes. Ask again if you still want it.`, a.kind);
        if (!hasPermission(member.role, rule.permission)) throw new Failure('FAILED', `You no longer have permission to ${rule.label.toLowerCase()}`, a.kind);
        let result: { path: string; label: string };
        try {
          result = await this.carryOut(tx, member, actor, input);
        } catch (e) {
          if (e instanceof DomainError) throw new Failure('FAILED', e.message, a.kind);
          if (e instanceof NotFoundException) throw new Failure('FAILED', 'The record it refers to no longer exists', a.kind);
          throw e;
        }
        await tx.copilotAction.update({ where: { id }, data: { status: 'DONE', result, decidedAt: new Date() } });
        await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'copilot.action_confirmed', entityType: 'copilot_action', entityId: id, data: { kind: a.kind, summary: a.summary, result } });
      });
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      failure = { status: e.status, error: e.message, kind: e.kind };
    }
    if (failure) {
      // Nothing was changed; record why, then tell the member.
      const f = failure;
      await this.prisma.$transaction(async (tx) => {
        await this.lockOpen(tx, member.orgId, actor, id);
        await tx.copilotAction.update({ where: { id }, data: { status: f.status, error: f.error, decidedAt: new Date() } });
        await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: f.status === 'EXPIRED' ? 'copilot.action_expired' : 'copilot.action_failed', entityType: 'copilot_action', entityId: id, data: { kind: f.kind, error: f.error } });
      });
    }
    return this.serialize(await this.prisma.copilotAction.findUniqueOrThrow({ where: { id } }));
  }

  private async carryOut(tx: Prisma.TransactionClient, member: Member, actor: Actor, input: ActionInput): Promise<{ path: string; label: string }> {
    if (input.kind === 'CREATE_TASK') {
      const t = await this.tasks.createInTx(tx, member.orgId, { title: input.title.trim(), description: input.description, assignTo: input.forRole ? { role: input.forRole } : { userId: actor.id }, dueDate: input.dueDate, createdById: actor.id, source: 'AI_AGENT' });
      return { path: '/tasks', label: `Task "${t.title}"` };
    }
    const title = input.kind === 'ACKNOWLEDGE_ALERT' ? await this.alerts.acknowledgeInTx(tx, member.orgId, actor, input.alertId, input.note) : await this.alerts.dismissInTx(tx, member.orgId, actor, input.alertId, input.reason.trim());
    return { path: '/alerts', label: `Alert "${title}"` };
  }

  async cancel(member: Member, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const a = await this.lockOpen(tx, member.orgId, actor, id);
      await tx.copilotAction.update({ where: { id }, data: { status: 'CANCELLED', decidedAt: new Date() } });
      await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'copilot.action_cancelled', entityType: 'copilot_action', entityId: id, data: { kind: a.kind, summary: a.summary } });
    });
    return this.serialize(await this.prisma.copilotAction.findUniqueOrThrow({ where: { id } }));
  }
}

class Failure extends Error {
  constructor(
    readonly status: 'EXPIRED' | 'FAILED',
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}
