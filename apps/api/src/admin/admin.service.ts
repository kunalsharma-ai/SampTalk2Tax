import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, PlatformRole } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';

const DAY_MS = 86_400_000;

/**
 * Platform administration: the people who run Talk2Tax look after organisations, people and
 * announcements. The boundary (ADMIN-021): administrators see each organisation's name,
 * country, region, members and status, never its books. Nothing here reads accounts,
 * journals, documents, contacts or any amount, and a platform role gives no access to an
 * organisation's own routes: those still need membership.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Organisations and memberships sit behind row-level security; admin reads cross tenants for metadata only. */
  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  async overview(now = new Date()) {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    return this.system(async (tx) => {
      const [organisations, suspended, demo, newOrganisations, people, inactive, newPeople, signedIn, admins] = await Promise.all([
        tx.organization.count(),
        tx.organization.count({ where: { suspendedAt: { not: null } } }),
        tx.organization.count({ where: { isDemo: true } }),
        tx.organization.count({ where: { createdAt: { gte: since } } }),
        tx.user.count(),
        tx.user.count({ where: { isActive: false } }),
        tx.user.count({ where: { createdAt: { gte: since } } }),
        tx.authSession.findMany({ where: { lastUsedAt: { gte: since } }, distinct: ['userId'], select: { userId: true } }),
        tx.user.findMany({ where: { platformRole: { not: null } }, select: { id: true, name: true, email: true, platformRole: true }, orderBy: { email: 'asc' } }),
      ]);
      return {
        organisations: { total: organisations, suspended, demo, createdLast30Days: newOrganisations },
        people: { total: people, disabled: inactive, joinedLast30Days: newPeople, signedInLast30Days: signedIn.length },
        administrators: admins,
      };
    });
  }

  async organisations(q: string | undefined, status: 'all' | 'active' | 'suspended') {
    const term = q?.trim();
    return this.system(async (tx) => {
      const rows = await tx.organization.findMany({
        where: {
          ...(term
            ? {
                OR: [
                  { name: { contains: term, mode: 'insensitive' as const } },
                  { legalName: { contains: term, mode: 'insensitive' as const } },
                  { memberships: { some: { user: { email: { contains: term.toLowerCase() } } } } },
                  ...(isUuid(term) ? [{ id: term }] : []),
                ],
              }
            : {}),
          ...(status === 'suspended' ? { suspendedAt: { not: null } } : status === 'active' ? { suspendedAt: null } : {}),
        },
        select: { ...ORG_FIELDS, _count: { select: { memberships: true } }, memberships: { where: { role: 'OWNER' }, select: { user: { select: { email: true } } }, take: 3 } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return rows.map((o) => ({ ...orgSummary(o), members: o._count.memberships, owners: o.memberships.map((m) => m.user.email) }));
    });
  }

  async organisation(id: string) {
    return this.system(async (tx) => {
      const o = await tx.organization.findUnique({
        where: { id },
        select: { ...ORG_FIELDS, memberships: { select: { role: true, createdAt: true, user: { select: { id: true, name: true, email: true, isActive: true } } }, orderBy: { createdAt: 'asc' } } },
      });
      if (!o) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      const history = await tx.auditEvent.findMany({
        where: { orgId: id, action: { startsWith: 'platform.' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { action: true, createdAt: true, data: true, actorId: true },
      });
      const actors = await names(tx, history.map((h) => h.actorId));
      return {
        ...orgSummary(o),
        members: o.memberships.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role, active: m.user.isActive, since: m.createdAt.toISOString() })),
        history: history.map((h) => ({ action: h.action, at: h.createdAt.toISOString(), by: h.actorId ? (actors.get(h.actorId) ?? null) : null, data: h.data })),
      };
    });
  }

  /** Suspends an organisation: its members can still read and export, but nothing can change. */
  async suspend(actor: AuthUser, id: string, reason: string) {
    const why = reason.trim();
    if (why.length < 5) throw new DomainError('REASON_REQUIRED', 'Say why the organisation is suspended (at least 5 characters); its members see it', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.system(async (tx) => {
      const o = await tx.organization.findUnique({ where: { id }, select: { suspendedAt: true } });
      if (!o) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      if (o.suspendedAt) throw new DomainError('ALREADY_SUSPENDED', 'The organisation is already suspended', HttpStatus.CONFLICT);
      await tx.organization.update({ where: { id }, data: { suspendedAt: new Date(), suspendedReason: why } });
      // In the organisation's own audit trail too, so its members can see who did it and why.
      await this.audit.append(tx, { orgId: id, actorId: actor.id, action: 'platform.org_suspended', entityType: 'organization', entityId: id, data: { reason: why } });
    });
    return this.organisation(id);
  }

  async reinstate(actor: AuthUser, id: string, note: string | undefined) {
    await this.system(async (tx) => {
      const o = await tx.organization.findUnique({ where: { id }, select: { suspendedAt: true, suspendedReason: true } });
      if (!o) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      if (!o.suspendedAt) throw new DomainError('NOT_SUSPENDED', 'The organisation is not suspended', HttpStatus.CONFLICT);
      await tx.organization.update({ where: { id }, data: { suspendedAt: null, suspendedReason: null } });
      await this.audit.append(tx, { orgId: id, actorId: actor.id, action: 'platform.org_reinstated', entityType: 'organization', entityId: id, data: { note: note?.trim() || null, suspendedFor: o.suspendedReason } });
    });
    return this.organisation(id);
  }

  async people(q: string | undefined) {
    const term = q?.trim().toLowerCase();
    // Membership counts cross tenants (row-level security), so they are read as the system.
    const users = await this.system((tx) => tx.user.findMany({
      where: term ? { OR: [{ email: { contains: term } }, { name: { contains: term, mode: 'insensitive' } }] } : {},
      select: { id: true, name: true, email: true, isActive: true, platformRole: true, createdAt: true, _count: { select: { memberships: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }));
    const ids = users.map((u) => u.id);
    const [seen, open] = await Promise.all([
      this.prisma.authSession.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _max: { lastUsedAt: true } }),
      this.prisma.authSession.groupBy({ by: ['userId'], where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: new Date() } }, _count: { _all: true } }),
    ]);
    const last = new Map(seen.map((s) => [s.userId, s._max.lastUsedAt]));
    const live = new Map(open.map((s) => [s.userId, s._count._all]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      active: u.isActive,
      platformRole: u.platformRole,
      organisations: u._count.memberships,
      joinedAt: u.createdAt.toISOString(),
      lastSeenAt: last.get(u.id)?.toISOString() ?? null,
      openSessions: live.get(u.id) ?? 0,
    }));
  }

  /** Disables a person: they cannot sign in and every session ends now. */
  async disable(actor: AuthUser, userId: string, reason: string) {
    const why = reason.trim();
    if (why.length < 5) throw new DomainError('REASON_REQUIRED', 'Say why the person is disabled (at least 5 characters)', HttpStatus.UNPROCESSABLE_ENTITY);
    if (userId === actor.id) throw new DomainError('NOT_YOURSELF', 'You cannot disable yourself', HttpStatus.CONFLICT);
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true, platformRole: true } });
      if (!u) throw new DomainError('NOT_FOUND', 'Person not found', HttpStatus.NOT_FOUND);
      if (!u.isActive) throw new DomainError('ALREADY_DISABLED', 'This person is already disabled', HttpStatus.CONFLICT);
      if (u.platformRole === 'SUPER_ADMIN') await this.keepOneSuperAdmin(tx, userId);
      await tx.user.update({ where: { id: userId }, data: { isActive: false } });
      const ended = await this.endSessions(tx, userId);
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.user_disabled', entityType: 'user', entityId: userId, data: { reason: why, sessionsEnded: ended } });
      return { userId, active: false, sessionsEnded: ended };
    });
  }

  async enable(actor: AuthUser, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true } });
      if (!u) throw new DomainError('NOT_FOUND', 'Person not found', HttpStatus.NOT_FOUND);
      if (u.isActive) throw new DomainError('ALREADY_ACTIVE', 'This person is already active', HttpStatus.CONFLICT);
      await tx.user.update({ where: { id: userId }, data: { isActive: true } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.user_enabled', entityType: 'user', entityId: userId });
      return { userId, active: true };
    });
  }

  /** Signs a person out everywhere (a lost laptop, a suspected compromise). */
  async signOut(actor: AuthUser, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw new DomainError('NOT_FOUND', 'Person not found', HttpStatus.NOT_FOUND);
      const ended = await this.endSessions(tx, userId);
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.user_signed_out', entityType: 'user', entityId: userId, data: { sessionsEnded: ended } });
      return { userId, sessionsEnded: ended };
    });
  }

  async setPlatformRole(actor: AuthUser, userId: string, role: PlatformRole | null) {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { platformRole: true, isActive: true } });
      if (!u) throw new DomainError('NOT_FOUND', 'Person not found', HttpStatus.NOT_FOUND);
      if (u.platformRole === role) return { userId, platformRole: role };
      if (role && !u.isActive) throw new DomainError('USER_DISABLED', 'Enable the person before giving them a platform role', HttpStatus.CONFLICT);
      if (u.platformRole === 'SUPER_ADMIN') await this.keepOneSuperAdmin(tx, userId);
      await tx.user.update({ where: { id: userId }, data: { platformRole: role } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.role_changed', entityType: 'user', entityId: userId, data: { before: u.platformRole, after: role } });
      return { userId, platformRole: role };
    });
  }

  /** Grants a platform role by email, for the first administrator (the admin:grant command). */
  async grant(email: string, role: PlatformRole) {
    const u = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, isActive: true, platformRole: true } });
    if (!u) throw new DomainError('USER_NOT_FOUND', `No registered person has the email ${email}; they register first`, HttpStatus.NOT_FOUND);
    if (!u.isActive) throw new DomainError('USER_DISABLED', 'That person is disabled', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { platformRole: role } });
      await this.audit.append(tx, { orgId: null, actorId: null, action: 'platform.role_changed', entityType: 'user', entityId: u.id, data: { before: u.platformRole, after: role, via: 'admin:grant command' } });
    });
    return { userId: u.id, platformRole: role };
  }

  // Announcements -----------------------------------------------------------------------------

  async announcements() {
    const rows = await this.prisma.platformAnnouncement.findMany({ orderBy: { startsAt: 'desc' }, take: 100, include: { creator: { select: { name: true } } } });
    const now = new Date();
    return rows.map((a) => ({ ...announcement(a), createdBy: a.creator.name, state: a.withdrawnAt ? 'WITHDRAWN' : a.startsAt > now ? 'SCHEDULED' : a.endsAt && a.endsAt <= now ? 'ENDED' : 'SHOWING' }));
  }

  async announce(actor: AuthUser, input: { message: string; tone: 'INFO' | 'WARNING'; startsAt?: string; endsAt?: string | null }) {
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw new DomainError('INVALID_WINDOW', 'The end must be after the start', HttpStatus.UNPROCESSABLE_ENTITY);
    if (endsAt && endsAt <= new Date()) throw new DomainError('INVALID_WINDOW', 'The end is already past', HttpStatus.UNPROCESSABLE_ENTITY);
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.platformAnnouncement.create({ data: { id: randomUUID(), message: input.message.trim(), tone: input.tone, startsAt, endsAt, createdBy: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.announcement_created', entityType: 'announcement', entityId: a.id, data: { message: a.message, tone: a.tone, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt?.toISOString() ?? null } });
      return announcement(a);
    });
  }

  async withdraw(actor: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.platformAnnouncement.findUnique({ where: { id } });
      if (!a) throw new DomainError('NOT_FOUND', 'Announcement not found', HttpStatus.NOT_FOUND);
      if (a.withdrawnAt) throw new DomainError('ALREADY_WITHDRAWN', 'The announcement is already withdrawn', HttpStatus.CONFLICT);
      const w = await tx.platformAnnouncement.update({ where: { id }, data: { withdrawnAt: new Date(), withdrawnBy: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.announcement_withdrawn', entityType: 'announcement', entityId: id });
      return announcement(w);
    });
  }

  /** What every signed-in person sees now. */
  async current(now = new Date()) {
    const rows = await this.prisma.platformAnnouncement.findMany({
      where: { withdrawnAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      orderBy: { startsAt: 'desc' },
      take: 5,
    });
    return rows.map((a) => ({ id: a.id, message: a.message, tone: a.tone, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt?.toISOString() ?? null }));
  }

  // -------------------------------------------------------------------------------------------

  private async endSessions(tx: Tx, userId: string) {
    const res = await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'platform_admin' } });
    return res.count;
  }

  private async keepOneSuperAdmin(tx: Tx, leaving: string) {
    const others = await tx.user.count({ where: { platformRole: 'SUPER_ADMIN', isActive: true, id: { not: leaving } } });
    if (others === 0) throw new DomainError('LAST_SUPER_ADMIN', 'Make someone else a super admin first: the platform must keep one', HttpStatus.CONFLICT);
  }
}

const ORG_FIELDS = {
  id: true,
  name: true,
  legalName: true,
  countryCode: true,
  functionalCurrency: true,
  dataRegion: true,
  isDemo: true,
  createdAt: true,
  suspendedAt: true,
  suspendedReason: true,
} as const;

function orgSummary(o: { id: string; name: string; legalName: string | null; countryCode: string; functionalCurrency: string; dataRegion: string | null; isDemo: boolean; createdAt: Date; suspendedAt: Date | null; suspendedReason: string | null }) {
  return {
    id: o.id,
    name: o.name,
    legalName: o.legalName,
    countryCode: o.countryCode,
    functionalCurrency: o.functionalCurrency,
    dataRegion: o.dataRegion,
    isDemo: o.isDemo,
    createdAt: o.createdAt.toISOString(),
    suspended: o.suspendedAt ? { at: o.suspendedAt.toISOString(), reason: o.suspendedReason } : null,
  };
}

function announcement(a: { id: string; message: string; tone: string; startsAt: Date; endsAt: Date | null; createdAt: Date; withdrawnAt: Date | null }) {
  return { id: a.id, message: a.message, tone: a.tone, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(), withdrawnAt: a.withdrawnAt?.toISOString() ?? null };
}

async function names(tx: Tx, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = unique.length ? await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
