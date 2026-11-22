import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ASSIGNABLE_ROLES, D, minorUnits, type AssignableRole } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { todayIso } from '../common/dates';
import { PaymentBatchesService } from '../payment-batches/payment-batches.service';
import { lockRow } from '../db/locks';

type Actor = { id: string };
type Member = { orgId: string; role: RoleName };

/** How long a proposal waits for the member before it expires. */
export const ACTION_EXPIRY_MINUTES = 15;

export const ACTION_KINDS = ['CREATE_TASK', 'ACKNOWLEDGE_ALERT', 'DISMISS_ALERT', 'PREPARE_PAYMENT_BATCH'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * AP-036: the assistant may prepare payments, never authorise or execute them. None of these may
 * ever become an action kind; the check below stops the server starting if one is added.
 */
export const NEVER_ASSISTANT_ACTIONS = ['APPROVE_PAYMENT_BATCH', 'DOWNLOAD_PAYMENT_FILE', 'RECORD_PAYMENT', 'MARK_BATCH_PAID', 'TRANSFER_FUNDS', 'VERIFY_BANK_DETAILS', 'EDIT_BANK_DETAILS'] as const;
for (const k of ACTION_KINDS) if ((NEVER_ASSISTANT_ACTIONS as readonly string[]).includes(k)) throw new Error(`${k} moves or authorises money and can never be an assistant action`);

/** At most this many bills in one batch the assistant prepares. */
export const ASSISTANT_BATCH_MAX_BILLS = 50;

/** What each action needs, and whether it is sensitive (changes something others rely on). */
export const ACTION_RULES: Record<ActionKind, { permission: Permission; sensitive: boolean; label: string }> = {
  CREATE_TASK: { permission: 'tasks.use', sensitive: false, label: 'Create a task' },
  ACKNOWLEDGE_ALERT: { permission: 'alerts.manage', sensitive: false, label: 'Acknowledge an alert' },
  DISMISS_ALERT: { permission: 'alerts.manage', sensitive: true, label: 'Dismiss an alert' },
  PREPARE_PAYMENT_BATCH: { permission: 'purchases.manage', sensitive: true, label: 'Prepare a payment batch' },
};

export type ActionInput =
  | { kind: 'CREATE_TASK'; title: string; description: string | null; dueDate: string | null; forRole: AssignableRole | null }
  | { kind: 'ACKNOWLEDGE_ALERT'; alertId: string; note: string | null }
  | { kind: 'DISMISS_ALERT'; alertId: string; reason: string }
  | { kind: 'PREPARE_PAYMENT_BATCH'; bankAccountId: string; paymentDate: string; documentIds: string[] };

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
    private readonly batches: PaymentBatchesService,
  ) {}

  /** Checks a proposal and stores it. Returns what the model is told. Throws DomainError when it cannot be proposed. */
  async propose(ctx: ProposalContext, input: ActionInput) {
    if (!(ACTION_KINDS as readonly string[]).includes(input.kind)) throw new DomainError('INVALID_ACTION', 'The assistant cannot propose that');
    const rule = ACTION_RULES[input.kind];
    if (!hasPermission(ctx.role, rule.permission)) throw new DomainError('FORBIDDEN', `This member cannot ${rule.label.toLowerCase()}, so it was not proposed`, HttpStatus.FORBIDDEN);
    const summary = await this.describe(ctx.orgId, input, ctx.role);
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
  private async describe(orgId: string, input: ActionInput, role: RoleName): Promise<string> {
    if (input.kind === 'PREPARE_PAYMENT_BATCH') return this.describeBatch(orgId, input, role);
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

  /** A batch the assistant proposes: an active bank account, a date from today, and payable bills not already in a batch. */
  private async describeBatch(orgId: string, input: Extract<ActionInput, { kind: 'PREPARE_PAYMENT_BATCH' }>, role: RoleName) {
    const ids = [...new Set(input.documentIds)];
    if (!ids.length || ids.length > ASSISTANT_BATCH_MAX_BILLS) throw new DomainError('INVALID_ACTION', `Choose 1 to ${ASSISTANT_BATCH_MAX_BILLS} bills from list_payable_bills`);
    if (input.paymentDate < todayIso()) throw new DomainError('INVALID_ACTION', 'The payment date cannot be in the past');
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    const bank = await this.prisma.account.findFirst({ where: { id: input.bankAccountId, orgId }, select: { name: true, subtype: true, isActive: true, isPostable: true } });
    if (!bank || bank.subtype !== 'BANK' || !bank.isActive || !bank.isPostable) throw new DomainError('INVALID_ACTION', 'There is no such active bank account; use a bank_account_ref from list_payable_bills');
    const payable = new Map((await this.batches.payableBills({ id: orgId, role, functionalCurrency: o.functionalCurrency })).map((b) => [b.id, b]));
    const bills = ids.map((id) => {
      const b = payable.get(id);
      if (!b) throw new DomainError('INVALID_ACTION', 'A bill is not open for payment; use bill_refs from list_payable_bills');
      if (b.inBatch) throw new DomainError('INVALID_ACTION', `${b.number} is already in batch ${b.inBatch}`);
      return b;
    });
    const scale = minorUnits(o.functionalCurrency);
    const total = bills.reduce((t, b) => t.plus(b.due), new D(0)).toFixed(scale);
    const listed = bills.slice(0, 5).map((b) => `${b.number} ${b.vendor.name} ${b.due}`).join('; ');
    return `Prepare a draft payment batch from ${bank.name}, dated ${input.paymentDate}, paying ${bills.length} ${bills.length === 1 ? 'bill' : 'bills'} for ${o.functionalCurrency} ${total} (${listed}${bills.length > 5 ? `; and ${bills.length - 5} more` : ''}). Nothing is paid: someone other than you must approve the batch before a bank file can be made.`;
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
      result: a.result as { path: string; label: string; batchId?: string } | null,
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
        if (!(ACTION_KINDS as readonly string[]).includes(input.kind)) throw new Failure('FAILED', 'The assistant cannot carry that out', a.kind);
        const rule = ACTION_RULES[input.kind];
        if (a.expiresAt.getTime() <= Date.now()) throw new Failure('EXPIRED', `This proposal expired after ${ACTION_EXPIRY_MINUTES} minutes. Ask again if you still want it.`, a.kind);
        if (!hasPermission(member.role, rule.permission)) throw new Failure('FAILED', `You no longer have permission to ${rule.label.toLowerCase()}`, a.kind);
        let result: { path: string; label: string; batchId?: string };
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

  private async carryOut(tx: Prisma.TransactionClient, member: Member, actor: Actor, input: ActionInput): Promise<{ path: string; label: string; batchId?: string }> {
    if (input.kind === 'PREPARE_PAYMENT_BATCH') {
      // Prepared as the member, as a draft only; approving it stays with another person.
      const o = await tx.organization.findUniqueOrThrow({ where: { id: member.orgId }, select: { functionalCurrency: true } });
      const b = await this.batches.createInTx(tx, { id: member.orgId, role: member.role, functionalCurrency: o.functionalCurrency }, actor, { bankAccountId: input.bankAccountId, paymentDate: input.paymentDate, memo: 'Prepared with the assistant', items: input.documentIds.map((documentId) => ({ documentId })) }, 'COPILOT');
      return { path: `/purchases/payment-batches/${b.id}`, label: `Payment batch ${b.reference} (draft, waiting for approval)`, batchId: b.id };
    }
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
