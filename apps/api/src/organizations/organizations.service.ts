import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { fiscalYearForDate, GENERIC_SMB_COA, generateFiscalYear } from '@talk2tax/accounting-engine';
import { Role } from '@talk2tax/database';
import { canAssignRole, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { toDbDate, todayIso } from '../common/dates';
import { PrismaService, Tx } from '../common/prisma.service';

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
  ) {}

  async create(userId: string, input: CreateOrgInput, today = todayIso()) {
    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.name,
          legalName: input.legalName,
          countryCode: input.countryCode,
          functionalCurrency: input.functionalCurrency,
          fiscalYearStartMonth: input.fiscalYearStartMonth,
          isDemo: input.isDemo ?? false,
        },
      });
      await tx.membership.create({ data: { orgId: org.id, userId, role: 'OWNER' } });
      if (input.chartTemplate === 'GENERIC_SMB') {
        const ids = await this.applyGenericChart(tx, org.id);
        await tx.organization.update({ where: { id: org.id }, data: { arAccountId: ids.get('1200'), apAccountId: ids.get('2100') } });
      }
      const fy = fiscalYearForDate(today, input.fiscalYearStartMonth);
      await this.createFiscalYear(tx, org.id, fy, input.fiscalYearStartMonth);
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: userId,
        action: 'organization.created',
        entityType: 'organization',
        entityId: org.id,
        data: { ...input, initialFiscalYear: fy },
      });
      return org;
    });
  }

  async applyGenericChart(tx: Tx, orgId: string) {
    const idByCode = new Map<string, string>();
    for (const a of GENERIC_SMB_COA) {
      const created = await tx.account.create({
        data: {
          orgId,
          code: a.code,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          isPostable: a.isPostable,
          parentId: a.parentCode ? idByCode.get(a.parentCode) : undefined,
        },
      });
      idByCode.set(a.code, created.id);
    }
    return idByCode;
  }

  async createFiscalYear(tx: Tx, orgId: string, fiscalYear: number, startMonth: number) {
    const periods = generateFiscalYear(fiscalYear, startMonth);
    await tx.fiscalPeriod.createMany({
      data: periods.map((p) => ({
        orgId,
        fiscalYear: p.fiscalYear,
        periodNo: p.periodNo,
        name: p.name,
        startDate: toDbDate(p.startDate),
        endDate: toDbDate(p.endDate),
      })),
    });
    return periods;
  }

  listForUser(userId: string) {
    return this.prisma.membership
      .findMany({ where: { userId }, include: { org: true }, orderBy: { createdAt: 'asc' } })
      .then((ms) => ms.map((m) => ({ ...serializeOrg(m.org), role: m.role })));
  }

  async get(orgId: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    return serializeOrg(org);
  }

  async listMembers(orgId: string) {
    const ms = await this.prisma.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return ms.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role, since: m.createdAt.toISOString() }));
  }

  /** Add an already-registered user to the organisation. Invitations by email are a later milestone. */
  async addMember(orgId: string, actor: { id: string; role: RoleName }, email: string, role: RoleName) {
    if (!canAssignRole(actor.role, role)) throw new ForbiddenException({ error: 'FORBIDDEN', message: `A ${actor.role} cannot grant ${role}` });
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'No registered user has that email' });
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId: user.id } } });
      if (existing) throw new ConflictException({ error: 'ALREADY_MEMBER', message: 'User is already a member' });
      const m = await tx.membership.create({ data: { orgId, userId: user.id, role: role as Role } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'member.added', entityType: 'membership', entityId: m.id, data: { userId: user.id, role } });
      return { userId: user.id, email: user.email, name: user.name, role: m.role };
    });
  }
}

function serializeOrg(o: {
  id: string;
  name: string;
  legalName: string | null;
  countryCode: string;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
  isDemo: boolean;
  arAccountId: string | null;
  apAccountId: string | null;
  createdAt: Date;
}) {
  return {
    id: o.id,
    name: o.name,
    legalName: o.legalName,
    countryCode: o.countryCode,
    functionalCurrency: o.functionalCurrency,
    fiscalYearStartMonth: o.fiscalYearStartMonth,
    isDemo: o.isDemo,
    arAccountId: o.arAccountId,
    apAccountId: o.apAccountId,
    createdAt: o.createdAt.toISOString(),
  };
}
