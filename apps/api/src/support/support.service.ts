import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  queueOrder,
  SupportCategory,
  SupportPriority,
  SupportStatus,
  supportGrantEnd,
  supportTargets,
  TicketAction,
  ticketReference,
  ticketTransition,
  TicketStateError,
} from '@talk2tax/accounting-engine';
import type { RoleName } from '@talk2tax/security';
import { hasPermission } from '@talk2tax/security';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PLATFORM_PERMISSIONS, type AuthUser, type PlatformRole } from '../auth/decorators';
import { AppConfig, CONFIG } from '../config';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { MailerService } from '../workflows/email';

type Ticket = {
  id: string;
  orgId: string;
  number: number;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdBy: string;
  assigneeId: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  lastMessageAt: Date;
  createdAt: Date;
};

const notFound = () => new DomainError('NOT_FOUND', 'Ticket not found', HttpStatus.NOT_FOUND);

function stateError(e: unknown): never {
  if (e instanceof TicketStateError) throw new DomainError(e.code, e.message, HttpStatus.CONFLICT);
  throw e;
}

function move(status: string, action: TicketAction): SupportStatus {
  try {
    return ticketTransition(status as SupportStatus, action);
  } catch (e) {
    stateError(e);
  }
}

/**
 * Support tickets (M9 slice 4). The organisation side works inside the organisation's tenant
 * context; the support side reads across organisations with system access, and only tickets,
 * their messages and the organisation's name and plan: never its books. Reading the books
 * needs the organisation's own support access grant (see SupportAccessService).
 */
@Injectable()
export class SupportService {
  private readonly log = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  /** Names for authors and assignees. Support staff are not members, so this reads users directly. */
  private async people(tx: Tx, ids: string[]) {
    const rows = await tx.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true, platformRole: true } });
    return new Map(rows.map((u) => [u.id, u]));
  }

  private summary(t: Ticket, now: Date, people: Map<string, { name: string; email: string }>) {
    const targets = supportTargets({ priority: t.priority as SupportPriority, createdAt: t.createdAt, firstResponseAt: t.firstResponseAt, resolvedAt: t.resolvedAt, closedAt: t.closedAt }, now);
    const creator = people.get(t.createdBy);
    const assignee = t.assigneeId ? people.get(t.assigneeId) : undefined;
    return {
      id: t.id,
      reference: ticketReference(t.number),
      subject: t.subject,
      category: t.category as SupportCategory,
      priority: t.priority as SupportPriority,
      status: t.status as SupportStatus,
      openedBy: creator ? { id: t.createdBy, name: creator.name, email: creator.email } : { id: t.createdBy, name: 'Unknown', email: '' },
      assignee: assignee && t.assigneeId ? { id: t.assigneeId, name: assignee.name } : null,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      firstResponseAt: t.firstResponseAt,
      resolvedAt: t.resolvedAt,
      closedAt: t.closedAt,
      targets,
    };
  }

  // ---------------------------------------------------------------- organisation side

  /** Owners and admins see all the organisation's tickets; everyone else sees the ones they opened. */
  private seesAll(role: RoleName) {
    return hasPermission(role, 'org.manage');
  }

  async listForOrg(orgId: string, user: AuthUser, role: RoleName, now = new Date()) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { orgId, ...(this.seesAll(role) ? {} : { createdBy: user.id }) },
      orderBy: [{ lastMessageAt: 'desc' }],
      take: 200,
    });
    const people = await this.prisma.$transaction((tx) => withSystemAccess(tx, () => this.people(tx, rows.flatMap((r) => [r.createdBy, ...(r.assigneeId ? [r.assigneeId] : [])]))));
    return rows.map((t) => this.summary(t, now, people));
  }

  async create(orgId: string, user: AuthUser, input: { subject: string; category: SupportCategory; priority: SupportPriority; body: string }) {
    const id = randomUUID();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicket.create({ data: { id, orgId, subject: input.subject, category: input.category, priority: input.priority, createdBy: user.id, lastMessageAt: now, createdAt: now } });
      await tx.supportMessage.create({ data: { id: randomUUID(), ticketId: id, orgId, authorId: user.id, side: 'CUSTOMER', body: input.body, createdAt: now } });
      await this.audit.append(tx, { orgId, actorId: user.id, action: 'support.ticket_opened', entityType: 'support_ticket', entityId: id, data: { subject: input.subject, category: input.category, priority: input.priority } });
    });
    return this.getForOrg(orgId, id, user, 'OWNER');
  }

  private async visibleTicket(tx: Tx, orgId: string, id: string, user: AuthUser, role: RoleName) {
    const t = await tx.supportTicket.findFirst({ where: { id, orgId } });
    if (!t || (!this.seesAll(role) && t.createdBy !== user.id)) throw notFound();
    return t;
  }

  async getForOrg(orgId: string, id: string, user: AuthUser, role: RoleName, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.visibleTicket(tx, orgId, id, user, role);
      // Internal notes are support's own: never sent to the organisation.
      const messages = await tx.supportMessage.findMany({ where: { ticketId: id, orgId, internal: false }, orderBy: { createdAt: 'asc' } });
      const grants = await tx.supportAccessGrant.findMany({ where: { orgId, ticketId: id }, orderBy: { createdAt: 'desc' } });
      const people = await withSystemAccess(tx, () => this.people(tx, [t.createdBy, ...(t.assigneeId ? [t.assigneeId] : []), ...messages.map((m) => m.authorId)]));
      return {
        ...this.summary(t, now, people),
        messages: messages.map((m) => ({
          id: m.id,
          side: m.side,
          // The organisation sees the support person's name, not their email.
          author: { name: people.get(m.authorId)?.name ?? 'Talk2Tax support', ...(m.side === 'CUSTOMER' ? { email: people.get(m.authorId)?.email ?? '' } : {}) },
          body: m.body,
          createdAt: m.createdAt,
        })),
        accessGrants: grants.map((g) => grantView(g, now)),
      };
    });
  }

  async replyAsCustomer(orgId: string, id: string, user: AuthUser, role: RoleName, body: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.visibleTicket(tx, orgId, id, user, role);
      const status = move(t.status, 'CUSTOMER_REPLY');
      const now = new Date();
      await tx.supportMessage.create({ data: { id: randomUUID(), ticketId: id, orgId, authorId: user.id, side: 'CUSTOMER', body, createdAt: now } });
      await tx.supportTicket.update({ where: { id }, data: { status, lastMessageAt: now } });
      if (status !== t.status) await this.audit.append(tx, { orgId, actorId: user.id, action: 'support.ticket_status', entityType: 'support_ticket', entityId: id, data: { from: t.status, to: status, by: 'CUSTOMER' } });
    });
    return this.getForOrg(orgId, id, user, role);
  }

  async customerAction(orgId: string, id: string, user: AuthUser, role: RoleName, action: 'CLOSE' | 'REOPEN') {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.visibleTicket(tx, orgId, id, user, role);
      const status = move(t.status, action);
      const now = new Date();
      await tx.supportTicket.update({ where: { id }, data: { status, ...(status === 'CLOSED' ? { closedAt: now } : {}) } });
      await this.audit.append(tx, { orgId, actorId: user.id, action: 'support.ticket_status', entityType: 'support_ticket', entityId: id, data: { from: t.status, to: status, by: 'CUSTOMER' } });
    });
    return this.getForOrg(orgId, id, user, role);
  }

  // ---------------------------------------------------------------- support access grants

  async access(orgId: string, now = new Date()) {
    const [grants, views] = await Promise.all([
      this.prisma.supportAccessGrant.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.supportAccessView.findMany({ where: { orgId }, orderBy: { id: 'desc' }, take: 100 }),
    ]);
    const tickets = await this.prisma.supportTicket.findMany({ where: { orgId, id: { in: grants.flatMap((g) => (g.ticketId ? [g.ticketId] : [])) } }, select: { id: true, number: true } });
    const people = await this.prisma.$transaction((tx) => withSystemAccess(tx, () => this.people(tx, [...grants.flatMap((g) => [g.grantedBy, ...(g.revokedBy ? [g.revokedBy] : [])]), ...views.map((v) => v.userId)])));
    const ref = new Map(tickets.map((t) => [t.id, ticketReference(t.number)]));
    const name = (id: string | null) => (id ? (people.get(id)?.name ?? 'Unknown') : null);
    return {
      active: grants.find((g) => !g.revokedAt && g.expiresAt > now) ? grantView(grants.find((g) => !g.revokedAt && g.expiresAt > now)!, now) : null,
      grants: grants.map((g) => ({ ...grantView(g, now), grantedBy: name(g.grantedBy), revokedBy: name(g.revokedBy), ticket: g.ticketId ? { id: g.ticketId, reference: ref.get(g.ticketId) ?? null } : null })),
      // Support staff are named (not emailed) so the organisation can see exactly who looked.
      views: views.map((v) => ({ id: v.id.toString(), grantId: v.grantId, by: name(v.userId), path: v.path.replace(/^\/v1\/orgs\/[0-9a-f-]{36}/, '') || '/', at: v.createdAt })),
    };
  }

  async grant(orgId: string, user: AuthUser, input: { hours: number; reason: string; ticketId?: string }) {
    const now = new Date();
    let expiresAt: Date;
    try {
      expiresAt = supportGrantEnd(input.hours, now);
    } catch (e) {
      throw new DomainError('INVALID_SUPPORT_ACCESS', (e as Error).message);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'support-access:' + orgId}))`;
      const active = await tx.supportAccessGrant.findFirst({ where: { orgId, revokedAt: null, expiresAt: { gt: now } } });
      if (active) throw new DomainError('SUPPORT_ACCESS_ACTIVE', 'Support already has access. End it first to grant it again on different terms.', HttpStatus.CONFLICT);
      if (input.ticketId) {
        const t = await tx.supportTicket.findFirst({ where: { id: input.ticketId, orgId } });
        if (!t) throw notFound();
        if (t.status === 'CLOSED') throw new DomainError('TICKET_CLOSED', 'This ticket is closed.', HttpStatus.CONFLICT);
      }
      const id = randomUUID();
      await tx.supportAccessGrant.create({ data: { id, orgId, ticketId: input.ticketId ?? null, reason: input.reason, grantedBy: user.id, createdAt: now, expiresAt } });
      if (input.ticketId) {
        // Said on the ticket too, so support knows they can look.
        await tx.supportMessage.create({ data: { id: randomUUID(), ticketId: input.ticketId, orgId, authorId: user.id, side: 'CUSTOMER', body: `Granted support read-only access to the books for ${input.hours} hour${input.hours === 1 ? '' : 's'}: ${input.reason}`, createdAt: now } });
        await tx.supportTicket.update({ where: { id: input.ticketId }, data: { lastMessageAt: now } });
      }
      await this.audit.append(tx, { orgId, actorId: user.id, action: 'support.access_granted', entityType: 'support_access_grant', entityId: id, data: { hours: input.hours, reason: input.reason, ticketId: input.ticketId ?? null, expiresAt: expiresAt.toISOString() } });
    });
    return this.access(orgId);
  }

  async revoke(orgId: string, grantId: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.supportAccessGrant.findFirst({ where: { id: grantId, orgId } });
      if (!g) throw new DomainError('NOT_FOUND', 'Support access grant not found', HttpStatus.NOT_FOUND);
      if (g.revokedAt || g.expiresAt <= new Date()) throw new DomainError('SUPPORT_ACCESS_ENDED', 'This support access has already ended.', HttpStatus.CONFLICT);
      await tx.supportAccessGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedBy: user.id } });
      await this.audit.append(tx, { orgId, actorId: user.id, action: 'support.access_revoked', entityType: 'support_access_grant', entityId: grantId });
    });
    return this.access(orgId);
  }

  // ---------------------------------------------------------------- support side

  async queue(user: AuthUser, filter: { status: 'active' | SupportStatus | 'all'; assigned: 'all' | 'me' | 'unassigned'; q?: string }, now = new Date()) {
    const term = filter.q?.trim();
    const number = term ? Number(term.replace(/^T-?/i, '')) : NaN;
    return this.system(async (tx) => {
      const rows = await tx.supportTicket.findMany({
        where: {
          ...(filter.status === 'active' ? { status: { in: ['OPEN', 'PENDING'] } } : filter.status === 'all' ? {} : { status: filter.status }),
          ...(filter.assigned === 'me' ? { assigneeId: user.id } : filter.assigned === 'unassigned' ? { assigneeId: null } : {}),
          ...(term ? { OR: [{ subject: { contains: term, mode: 'insensitive' as const } }, ...(Number.isInteger(number) && number > 0 ? [{ number }] : [])] } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 300,
      });
      const [people, orgs, counts, grants] = await Promise.all([
        this.people(tx, rows.flatMap((r) => [r.createdBy, ...(r.assigneeId ? [r.assigneeId] : [])])),
        tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orgId))] } }, select: { id: true, name: true, countryCode: true } }),
        tx.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
        tx.supportAccessGrant.findMany({ where: { orgId: { in: [...new Set(rows.map((r) => r.orgId))] }, revokedAt: null, expiresAt: { gt: now } }, select: { orgId: true, expiresAt: true } }),
      ]);
      const orgById = new Map(orgs.map((o) => [o.id, o]));
      const access = new Map(grants.map((g) => [g.orgId, g.expiresAt]));
      const tickets = rows
        .map((t) => {
          const s = this.summary(t, now, people);
          const next = t.firstResponseAt ? s.targets.resolution : s.targets.firstResponse;
          return { ...s, org: { id: t.orgId, name: orgById.get(t.orgId)?.name ?? '', countryCode: orgById.get(t.orgId)?.countryCode ?? '' }, supportAccessUntil: access.get(t.orgId) ?? null, next };
        })
        .sort(queueOrder);
      const byStatus = Object.fromEntries(['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'].map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0]));
      const overdue = tickets.filter((t) => ['OPEN', 'PENDING'].includes(t.status) && t.next.state === 'OVERDUE').length;
      return { tickets, counts: { ...byStatus, overdue } };
    });
  }

  private async staff(tx: Tx) {
    const rows = await tx.user.findMany({ where: { platformRole: { not: null }, isActive: true }, select: { id: true, name: true, email: true, platformRole: true }, orderBy: { name: 'asc' } });
    return rows.filter((u) => PLATFORM_PERMISSIONS[u.platformRole as PlatformRole]?.includes('platform.support'));
  }

  async ticketForSupport(id: string, now = new Date()) {
    return this.system(async (tx) => {
      const t = await tx.supportTicket.findUnique({ where: { id } });
      if (!t) throw notFound();
      const [messages, org, grants, staff] = await Promise.all([
        tx.supportMessage.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
        tx.organization.findUnique({ where: { id: t.orgId }, select: { id: true, name: true, countryCode: true, suspendedAt: true, subscription: { select: { status: true, plan: { select: { name: true } } } } } }),
        tx.supportAccessGrant.findMany({ where: { orgId: t.orgId }, orderBy: { createdAt: 'desc' }, take: 5 }),
        this.staff(tx),
      ]);
      const people = await this.people(tx, [t.createdBy, ...(t.assigneeId ? [t.assigneeId] : []), ...messages.map((m) => m.authorId)]);
      const active = grants.find((g) => !g.revokedAt && g.expiresAt > now);
      return {
        ...this.summary(t, now, people),
        org: org ? { id: org.id, name: org.name, countryCode: org.countryCode, suspended: !!org.suspendedAt, plan: org.subscription ? { name: org.subscription.plan.name, status: org.subscription.status } : null } : null,
        supportAccess: active ? grantView(active, now) : null,
        messages: messages.map((m) => ({ id: m.id, side: m.side, internal: m.internal, author: { name: people.get(m.authorId)?.name ?? 'Unknown', email: people.get(m.authorId)?.email ?? '' }, body: m.body, createdAt: m.createdAt })),
        staff: staff.map((s) => ({ id: s.id, name: s.name, email: s.email })),
      };
    });
  }

  /**
   * A reply the customer sees (emailed to whoever opened the ticket, through the
   * organisation's mail set-up) or an internal note they never see.
   */
  async replyAsSupport(id: string, user: AuthUser, input: { body: string; internal: boolean; resolve?: boolean }) {
    const result = await this.system(async (tx) => {
      const t = await tx.supportTicket.findUnique({ where: { id } });
      if (!t) throw notFound();
      let status = move(t.status, input.internal ? 'SUPPORT_NOTE' : 'SUPPORT_REPLY');
      if (input.resolve && !input.internal) status = 'RESOLVED';
      const now = new Date();
      await tx.supportMessage.create({ data: { id: randomUUID(), ticketId: id, orgId: t.orgId, authorId: user.id, side: 'SUPPORT', internal: input.internal, body: input.body, createdAt: now } });
      await tx.supportTicket.update({
        where: { id },
        data: {
          status,
          ...(input.internal ? {} : { lastMessageAt: now }),
          ...(!input.internal && !t.firstResponseAt ? { firstResponseAt: now } : {}),
          ...(status === 'RESOLVED' && !t.resolvedAt ? { resolvedAt: now } : {}),
          // Whoever answers first takes the ticket, unless it is already someone's.
          ...(!t.assigneeId ? { assigneeId: user.id } : {}),
        },
      });
      if (status !== t.status) await this.audit.append(tx, { orgId: t.orgId, actorId: user.id, action: 'support.ticket_status', entityType: 'support_ticket', entityId: id, data: { from: t.status, to: status, by: 'SUPPORT' } });
      const creator = await tx.user.findUnique({ where: { id: t.createdBy }, select: { email: true, isActive: true } });
      return { t, creator };
    });
    let emailed: { ok: boolean; to: string | null; error: string | null } | null = null;
    if (!input.internal) {
      const to = result.creator?.isActive ? result.creator.email : null;
      if (!to) emailed = { ok: false, to: null, error: 'The person who opened the ticket can no longer sign in' };
      else {
        const ref = ticketReference(result.t.number);
        const link = `${this.config.APP_URL.replace(/\/$/, '')}/orgs/${result.t.orgId}/support/${id}`;
        // Sent through the organisation's own mail set-up, so in that organisation's context.
        const r = await tenantStorage.run({ orgId: result.t.orgId, userId: user.id }, async () => await this.mailer.send(result.t.orgId, {
          to: [to],
          subject: `[${ref}] ${result.t.subject}`,
          text: `${user.name} from Talk2Tax support replied to your ticket ${ref}:\n\n${input.body}\n\nReply or close the ticket in Talk2Tax: ${link}\n`,
          messageId: `<support-${id}-${Date.now()}@talk2tax>`,
        }));
        emailed = { ok: r.ok, to, error: r.error };
        if (!r.ok) this.log.warn(`Support reply on ${ref} not emailed: ${r.error}`);
      }
    }
    return { ticket: await this.ticketForSupport(id), emailed };
  }

  async updateBySupport(id: string, user: AuthUser, input: { priority?: SupportPriority; assigneeId?: string | null; action?: 'RESOLVE' | 'CLOSE' | 'REOPEN' }) {
    await this.system(async (tx) => {
      const t = await tx.supportTicket.findUnique({ where: { id } });
      if (!t) throw notFound();
      if (input.assigneeId) {
        const staff = await this.staff(tx);
        if (!staff.some((s) => s.id === input.assigneeId)) throw new DomainError('NOT_SUPPORT_STAFF', 'Tickets can only be assigned to people with a support role', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const now = new Date();
      const status = input.action ? move(t.status, input.action) : (t.status as SupportStatus);
      if (t.status === 'CLOSED' && (input.priority || input.assigneeId !== undefined)) stateError(new TicketStateError('TICKET_CLOSED', 'This ticket is closed.'));
      await tx.supportTicket.update({
        where: { id },
        data: {
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          status,
          ...(status === 'RESOLVED' && !t.resolvedAt ? { resolvedAt: now } : {}),
          ...(status === 'CLOSED' ? { closedAt: now } : {}),
        },
      });
      await this.audit.append(tx, {
        orgId: t.orgId,
        actorId: user.id,
        action: input.action ? 'support.ticket_status' : 'support.ticket_updated',
        entityType: 'support_ticket',
        entityId: id,
        data: { ...(input.action ? { from: t.status, to: status, by: 'SUPPORT' } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}) },
      });
    });
    return this.ticketForSupport(id);
  }
}

function grantView(g: { id: string; ticketId: string | null; reason: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null }, now: Date) {
  return {
    id: g.id,
    ticketId: g.ticketId,
    reason: g.reason,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    revokedAt: g.revokedAt,
    state: g.revokedAt ? ('REVOKED' as const) : g.expiresAt > now ? ('ACTIVE' as const) : ('EXPIRED' as const),
  };
}
