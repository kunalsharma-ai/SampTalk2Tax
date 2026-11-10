import { ConflictException, ForbiddenException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fiscalYearForDate, GENERIC_SMB_COA, isTimeZone } from '@talk2tax/accounting-engine';
import { Role } from '@talk2tax/database';
import { canAssignRole, RoleName } from '@talk2tax/security';
import { RegionsService } from '../regions/regions.service';
import { accessOf, assertMemberRoom } from '../billing/limits';
import { startSubscription } from '../billing/start';
import { AppConfig, CONFIG } from '../config';
import { AuditService } from '../audit/audit.service';
import { todayIso } from '../common/dates';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, useOrgInTx, withSystemAccess } from '../common/prisma.service';
import { DomainError } from '../common/errors';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { users } from '../db/collections/identity';
import { accounts } from '../db/collections/chart';
import { memberships, organizations, type OrganizationDoc } from '../db/collections/tenancy';
import { PeriodsService } from '../periods/periods.service';
import { PostgresMirrorService, thenInPostgres } from '../db/postgres-mirror.service';

export interface CreateOrgInput {
  name: string;
  legalName?: string;
  countryCode: string;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
  chartTemplate: 'GENERIC_SMB' | 'EMPTY';
  isDemo?: boolean;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly regions: RegionsService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
    private readonly periods: PeriodsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get trialDays() {
    return this.config.PLAN_TRIAL_DAYS;
  }

  /**
   * The organisation, its first owner, its chart of accounts and its first fiscal year are
   * created in MongoDB. They are then copied to PostgreSQL with the subscription and audit
   * record (those modules have not moved yet); if that part fails, the MongoDB half is removed.
   */
  async create(userId: string, input: CreateOrgInput, today = todayIso()) {
    const id = randomUUID();
    const now = new Date();
    const fy = fiscalYearForDate(today, input.fiscalYearStartMonth);
    const made = { ownerId: '', accountIds: [] as string[], periodIds: [] as string[] };
    const undo = () =>
      runInOrg(id, async () => {
        await this.periods.removeFiscalYear(id, made.periodIds);
        // Children first: an account with children cannot be deleted.
        for (const accountId of [...made.accountIds].reverse()) await this.store.collection(accounts).deleteOne({ id: accountId });
        // The organisation goes before its owner, so removing its only owner is allowed.
        await this.store.collection(organizations).deleteOne({ id });
        if (made.ownerId) await this.store.collection(memberships).deleteOne({ id: made.ownerId });
      });
    const org = await this.store.transaction(async () => {
      const org = await this.store.collection(organizations).insertOne({
        id,
        name: input.name,
        legalName: input.legalName ?? null,
        timeZone: 'Asia/Kolkata',
        countryCode: input.countryCode,
        functionalCurrency: input.functionalCurrency,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        isDemo: input.isDemo ?? false,
        dataRegion: this.regions.current,
        suspendedAt: null,
        suspendedReason: null,
        arAccountId: null,
        apAccountId: null,
        claimsAccountId: null,
        createdAt: now,
        updatedAt: now,
      });
      const owner = await runInOrg(id, () => this.store.collection(memberships).insertOne({ userId, role: 'OWNER', createdAt: now }));
      made.ownerId = owner.id;
      if (input.chartTemplate === 'GENERIC_SMB') {
        const ids = await this.applyGenericChart(id, now);
        made.accountIds = [...ids.values()];
        const control = { arAccountId: ids.get('1200') ?? null, apAccountId: ids.get('2100') ?? null, claimsAccountId: ids.get('2250') ?? null };
        await this.store.collection(organizations).updateOne({ id }, { $set: control });
        Object.assign(org, control);
      }
      made.periodIds = (await this.periods.insertFiscalYear(id, fy, input.fiscalYearStartMonth)).map((p) => p.id);
      return org;
    });
    return thenInPostgres(
      org,
      async () => {
        await this.prisma.$transaction(async (tx) => {
          // The new organisation is the tenant for the rest of this transaction (row-level security).
          await useOrgInTx(tx, id);
          // The organisation and its control accounts point at each other.
          await this.mirror.organizations([id], tx, { withoutAccounts: true });
          await this.mirror.memberships([made.ownerId], tx);
          await this.mirror.accounts(made.accountIds, tx);
          await this.mirror.organizations([id], tx);
          await this.mirror.fiscalPeriods(made.periodIds, tx);
          await startSubscription(tx, org, userId, this.trialDays);
          await this.audit.append(tx, {
            orgId: org.id,
            actorId: userId,
            action: 'organization.created',
            entityType: 'organization',
            entityId: org.id,
            data: { ...input, initialFiscalYear: fy, dataRegion: this.regions.current },
          });
        });
      },
      undo,
    );
  }

  /** Adds the generic small-business chart in MongoDB. Returns account ids by code. */
  async applyGenericChart(orgId: string, now = new Date()) {
    const idByCode = new Map<string, string>();
    await runInOrg(orgId, async () => {
      for (const a of GENERIC_SMB_COA) {
        const created = await this.store.collection(accounts).insertOne({
          code: a.code,
          name: a.name,
          type: a.type,
          subtype: a.subtype ?? null,
          description: null,
          isPostable: a.isPostable,
          isActive: true,
          parentId: a.parentCode ? (idByCode.get(a.parentCode) ?? null) : null,
          createdAt: now,
          updatedAt: now,
        });
        idByCode.set(a.code, created.id);
      }
    });
    return idByCode;
  }

  /** The organisations a person belongs to, oldest membership first. */
  async listForUser(userId: string) {
    const ms = await runAsSystem(() => this.store.collection(memberships).find({ userId }, { sort: { createdAt: 1 } }));
    const orgs = new Map((await this.store.collection(organizations).find({ id: { $in: ms.map((m) => m.orgId) } })).map((o) => [o.id, o]));
    const subs = new Map(
      (
        await this.prisma.$transaction((tx) => withSystemAccess(tx, () => tx.subscription.findMany({ where: { orgId: { in: ms.map((m) => m.orgId) } }, include: { plan: true } })))
      ).map((s) => [s.orgId, s]),
    );
    return ms
      .filter((m) => orgs.has(m.orgId))
      .map((m) => {
        const org = orgs.get(m.orgId)!;
        return { ...serializeOrg(org), dataRegion: this.regions.describe(org.dataRegion), subscription: subscriptionSummary(subs.get(m.orgId) ?? null), role: m.role };
      });
  }

  async get(orgId: string) {
    const org = await this.store.collection(organizations).findById(orgId);
    if (!org) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Organization not found' });
    const sub = await this.prisma.subscription.findUnique({ where: { orgId }, include: { plan: true } });
    return { ...serializeOrg(org), dataRegion: this.regions.describe(org.dataRegion), subscription: subscriptionSummary(sub) };
  }

  /** The time zone moments are shown in for this organisation (display only). */
  async setTimeZone(orgId: string, actorId: string, timeZone: string) {
    if (!isTimeZone(timeZone)) throw new DomainError('INVALID_TIME_ZONE', 'Choose a time zone such as Asia/Kolkata or Europe/London', HttpStatus.UNPROCESSABLE_ENTITY);
    const before = await this.store.collection(organizations).findById(orgId);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Organization not found' });
    await this.store.collection(organizations).updateOne({ id: orgId }, { $set: { timeZone, updatedAt: new Date() } });
    await this.prisma.$transaction(async (tx) => {
      await this.mirror.organizations([orgId], tx);
      await this.audit.append(tx, { orgId, actorId, action: 'org.time_zone_changed', entityType: 'organization', entityId: orgId, data: { before: before.timeZone, after: timeZone } });
    });
    return this.get(orgId);
  }

  async listMembers(orgId: string) {
    const ms = await runInOrg(orgId, () => this.store.collection(memberships).find({}, { sort: { createdAt: 1 } }));
    const people = new Map((await this.store.collection(users).find({ id: { $in: ms.map((m) => m.userId) } })).map((u) => [u.id, u]));
    return ms
      .filter((m) => people.has(m.userId))
      .map((m) => {
        const u = people.get(m.userId)!;
        return { userId: u.id, email: u.email, name: u.name, role: m.role, since: m.createdAt.toISOString() };
      });
  }

/** Add an already-registered user to the organisation. Invitations by email are a later milestone. */
  async addMember(orgId: string, actor: { id: string; role: RoleName }, email: string, role: RoleName) {
    if (!canAssignRole(actor.role, role)) throw new ForbiddenException({ error: 'FORBIDDEN', message: `A ${actor.role} cannot grant ${role}` });
    const user = await this.store.collection(users).findOne({ email: email.trim().toLowerCase() });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'No registered user has that email' });
    const members = this.store.collection(memberships);
    if (await runInOrg(orgId, () => members.exists({ userId: user.id }))) throw new ConflictException({ error: 'ALREADY_MEMBER', message: 'User is already a member' });
    await this.prisma.$transaction((tx) => assertMemberRoom(tx, this.store, orgId, { countOpenInvitations: true }));
    const m = await runInOrg(orgId, () => members.insertOne({ userId: user.id, role: role as Role, createdAt: new Date() })).catch((e: unknown) => {
      throw isDuplicateKeyError(e) ? new ConflictException({ error: 'ALREADY_MEMBER', message: 'User is already a member' }) : e;
    });
    return thenInPostgres(
      { userId: user.id, email: user.email, name: user.name, role: m.role },
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.mirror.memberships([m.id], tx);
          await this.audit.append(tx, { orgId, actorId: actor.id, action: 'member.added', entityType: 'membership', entityId: m.id, data: { userId: user.id, role } });
        }),
      () => runInOrg(orgId, async () => void (await members.deleteOne({ id: m.id }))),
    );
  }
}

function serializeOrg(o: Pick<OrganizationDoc, 'id' | 'name' | 'legalName' | 'countryCode' | 'functionalCurrency' | 'fiscalYearStartMonth' | 'isDemo' | 'arAccountId' | 'apAccountId' | 'claimsAccountId' | 'timeZone' | 'createdAt' | 'suspendedAt' | 'suspendedReason'> | {
  id: string;
  name: string;
  legalName: string | null;
  countryCode: string;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
  isDemo: boolean;
  arAccountId: string | null;
  apAccountId: string | null;
  claimsAccountId: string | null;
  timeZone: string;
  createdAt: Date;
  suspendedAt: Date | null;
  suspendedReason: string | null;
}) {
  return {
    id: o.id,
    name: o.name,
    legalName: o.legalName,
    countryCode: o.countryCode,
    functionalCurrency: o.functionalCurrency,
    fiscalYearStartMonth: o.fiscalYearStartMonth,
    isDemo: o.isDemo,
    timeZone: o.timeZone,
    arAccountId: o.arAccountId,
    apAccountId: o.apAccountId,
    claimsAccountId: o.claimsAccountId,
    createdAt: o.createdAt.toISOString(),
    /** Suspended by the platform: readable, not changeable. */
    suspended: o.suspendedAt ? { at: o.suspendedAt.toISOString(), reason: o.suspendedReason } : null,
  };
}

/** What the web app needs to show plan state: the plan, its modules, and whether the books can change. */
function subscriptionSummary(s: { status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null; plan: { code: string; name: string; features: string[] } } | null) {
  if (!s) return null;
  return { plan: { code: s.plan.code, name: s.plan.name, features: s.plan.features }, status: s.status, access: accessOf(s) };
}
