import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, PlatformRole } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { users as usersCollection } from '../db/collections/identity';
import { organizations } from '../db/collections/tenancy';
import { PostgresMirrorService } from '../db/postgres-mirror.service';

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
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
    private readonly sessions: SessionsService,
  ) {}

  private get people_() {
    return this.store.collection(usersCollection);
  }

  /** Organisations and memberships sit behind row-level security; admin reads cross tenants for metadata only. */
  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  async overview(now = new Date()) {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const [orgCounts, people, inactive, newPeople, signedIn, admins] = await Promise.all([
      this.system((tx) =>
        Promise.all([
          tx.organization.count(),
          tx.organization.count({ where: { suspendedAt: { not: null } } }),
          tx.organization.count({ where: { isDemo: true } }),
          tx.organization.count({ where: { createdAt: { gte: since } } }),
        ]),
      ),
      this.people_.count(),
      this.people_.count({ isActive: false }),
      this.people_.count({ createdAt: { $gte: since } }),
      this.sessions.peopleSeenSince(since),
      this.people_.find({ platformRole: { $ne: null } }, { sort: { email: 1 } }),
    ]);
    const [organisations, suspended, demo, newOrganisations] = orgCounts;
    return {
      organisations: { total: organisations, suspended, demo, createdLast30Days: newOrganisations },
      people: { total: people, disabled: inactive, joinedLast30Days: newPeople, signedInLast30Days: signedIn },
      administrators: admins.map((a) => ({ id: a.id, name: a.name, email: a.email, platformRole: a.platformRole })),
    };
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
    const orgs = this.store.collection(organizations);
    const o = await orgs.findById(id);
    if (!o) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
    if (o.suspendedAt) throw new DomainError('ALREADY_SUSPENDED', 'The organisation is already suspended', HttpStatus.CONFLICT);
    const r = await orgs.updateOne({ id, suspendedAt: null }, { $set: { suspendedAt: new Date(), suspendedReason: why, updatedAt: new Date() } });
    if (r.modified === 0) throw new DomainError('ALREADY_SUSPENDED', 'The organisation is already suspended', HttpStatus.CONFLICT);
    // In the organisation's own audit trail too, so its members can see who did it and why.
    await this.system(async (tx) => {
      await this.mirror.organizations([id], tx);
      await this.audit.append(tx, { orgId: id, actorId: actor.id, action: 'platform.org_suspended', entityType: 'organization', entityId: id, data: { reason: why } });
    });
    return this.organisation(id);
  }

  async reinstate(actor: AuthUser, id: string, note: string | undefined) {
    const orgs = this.store.collection(organizations);
    const o = await orgs.findById(id);
    if (!o) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
    if (!o.suspendedAt) throw new DomainError('NOT_SUSPENDED', 'The organisation is not suspended', HttpStatus.CONFLICT);
    const r = await orgs.updateOne({ id, suspendedAt: { $ne: null } }, { $set: { suspendedAt: null, suspendedReason: null, updatedAt: new Date() } });
    if (r.modified === 0) throw new DomainError('NOT_SUSPENDED', 'The organisation is not suspended', HttpStatus.CONFLICT);
    await this.system(async (tx) => {
      await this.mirror.organizations([id], tx);
      await this.audit.append(tx, { orgId: id, actorId: actor.id, action: 'platform.org_reinstated', entityType: 'organization', entityId: id, data: { note: note?.trim() || null, suspendedFor: o.suspendedReason } });
    });
    return this.organisation(id);
  }

  async people(q: string | undefined) {
    const term = q?.trim().toLowerCase();
    const pattern = term ? escapeRegex(term) : undefined;
    const users = await this.people_.find(
      pattern ? { $or: [{ email: { $regex: pattern } }, { name: { $regex: pattern, $options: 'i' } }] } : {},
      { sort: { createdAt: -1 }, limit: 200 },
    );
    const ids = users.map((u) => u.id);
    // Membership counts cross tenants (row-level security), so they are read as the system.
    const [memberships, activity] = await Promise.all([
      ids.length ? this.system((tx) => tx.membership.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } })) : [],
      this.sessions.activity(ids),
    ]);
    const orgCount = new Map(memberships.map((m) => [m.userId, m._count._all]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      active: u.isActive,
      platformRole: u.platformRole,
      organisations: orgCount.get(u.id) ?? 0,
      joinedAt: u.createdAt.toISOString(),
      lastSeenAt: activity.get(u.id)?.lastUsedAt.toISOString() ?? null,
      openSessions: activity.get(u.id)?.open ?? 0,
    }));
  }

  /** Disables a person: they cannot sign in and every session ends now. */
  async disable(actor: AuthUser, userId: string, reason: string) {
    const why = reason.trim();
    if (why.length < 5) throw new DomainError('REASON_REQUIRED', 'Say why the person is disabled (at least 5 characters)', HttpStatus.UNPROCESSABLE_ENTITY);
    if (userId === actor.id) throw new DomainError('NOT_YOURSELF', 'You cannot disable yourself', HttpStatus.CONFLICT);
    const ended = await this.store.transaction(async () => {
      const u = await this.person(userId);
      if (!u.isActive) throw new DomainError('ALREADY_DISABLED', 'This person is already disabled', HttpStatus.CONFLICT);
      if (u.platformRole === 'SUPER_ADMIN') await this.keepOneSuperAdmin(userId);
      await this.people_.updateOne({ id: userId }, { $set: { isActive: false, updatedAt: new Date() } });
      return this.sessions.revokeOthersInStore(userId, null, 'platform_admin');
    });
    await this.recordInPostgres(userId, { orgId: null, actorId: actor.id, action: 'platform.user_disabled', entityType: 'user', entityId: userId, data: { reason: why, sessionsEnded: ended } });
    return { userId, active: false, sessionsEnded: ended };
  }

  async enable(actor: AuthUser, userId: string) {
    await this.store.transaction(async () => {
      const u = await this.person(userId);
      if (u.isActive) throw new DomainError('ALREADY_ACTIVE', 'This person is already active', HttpStatus.CONFLICT);
      await this.people_.updateOne({ id: userId }, { $set: { isActive: true, updatedAt: new Date() } });
    });
    await this.recordInPostgres(userId, { orgId: null, actorId: actor.id, action: 'platform.user_enabled', entityType: 'user', entityId: userId });
    return { userId, active: true };
  }

  /** Signs a person out everywhere (a lost laptop, a suspected compromise). */
  async signOut(actor: AuthUser, userId: string) {
    await this.person(userId);
    const ended = await this.sessions.revokeOthersInStore(userId, null, 'platform_admin');
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.user_signed_out', entityType: 'user', entityId: userId, data: { sessionsEnded: ended } }));
    return { userId, sessionsEnded: ended };
  }

  async setPlatformRole(actor: AuthUser, userId: string, role: PlatformRole | null) {
    const before = await this.store.transaction(async () => {
      const u = await this.person(userId);
      if (u.platformRole === role) return undefined;
      if (role && !u.isActive) throw new DomainError('USER_DISABLED', 'Enable the person before giving them a platform role', HttpStatus.CONFLICT);
      if (u.platformRole === 'SUPER_ADMIN') await this.keepOneSuperAdmin(userId);
      await this.people_.updateOne({ id: userId }, { $set: { platformRole: role, updatedAt: new Date() } });
      return { platformRole: u.platformRole };
    });
    if (before) {
      await this.recordInPostgres(userId, { orgId: null, actorId: actor.id, action: 'platform.role_changed', entityType: 'user', entityId: userId, data: { before: before.platformRole, after: role } });
    }
    return { userId, platformRole: role };
  }

  /** Grants a platform role by email, for the first administrator (the admin:grant command). */
  async grant(email: string, role: PlatformRole) {
    const u = await this.people_.findOne({ email: email.trim().toLowerCase() });
    if (!u) throw new DomainError('USER_NOT_FOUND', `No registered person has the email ${email}; they register first`, HttpStatus.NOT_FOUND);
    if (!u.isActive) throw new DomainError('USER_DISABLED', 'That person is disabled', HttpStatus.CONFLICT);
    await this.people_.updateOne({ id: u.id }, { $set: { platformRole: role, updatedAt: new Date() } });
    await this.recordInPostgres(u.id, { orgId: null, actorId: null, action: 'platform.role_changed', entityType: 'user', entityId: u.id, data: { before: u.platformRole, after: role, via: 'admin:grant command' } });
    return { userId: u.id, platformRole: role };
  }

  private async person(userId: string) {
    const u = await this.people_.findById(userId);
    if (!u) throw new DomainError('NOT_FOUND', 'Person not found', HttpStatus.NOT_FOUND);
    return u;
  }

  /** Copies the changed person to PostgreSQL and records the change in the audit trail. */
  private async recordInPostgres(userId: string, event: Parameters<AuditService['append']>[1]) {
    await this.prisma.$transaction(async (tx) => {
      await this.mirror.users([userId], tx);
      await this.audit.append(tx, event);
    });
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

  private async keepOneSuperAdmin(leaving: string) {
    const others = await this.people_.count({ platformRole: 'SUPER_ADMIN', isActive: true, id: { $ne: leaving } });
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

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
