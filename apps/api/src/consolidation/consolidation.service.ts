import { HttpStatus, Injectable } from '@nestjs/common';
import { ConsolidationError, D, checkOwnershipPercent, intercompanyEliminations, checkTranslationRates, consolidate, formatDate, minorUnits, type ConsolidationEntity, type ConsolidationResult, type ExportFormat, type ExportReport, type ExportRow } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { currentTenantContext, tenantStorage } from '../common/tenant-context';
import { ReportsService } from '../reports/reports.service';
import { renderExportFile, type ExportedFile } from '../report-exports/report-exports.service';

type Actor = { id: string };
type Tx = Prisma.TransactionClient;

export interface RateInput {
  memberOrgId: string;
  periodEnd: string;
  closing: string;
  average: string;
  historical: string;
}
export interface IntercompanyAccountsInput {
  receivable: string | null;
  payable: string | null;
  revenue: string | null;
  expense: string | null;
}
const IC_ACCOUNT_TYPES = { receivable: 'ASSET', payable: 'LIABILITY', revenue: 'REVENUE', expense: 'EXPENSE' } as const;
const IC_LABELS = { receivable: 'receivable', payable: 'payable', revenue: 'revenue', expense: 'expense' } as const;
type IcMember = { icReceivableCode: string | null; icPayableCode: string | null; icRevenueCode: string | null; icExpenseCode: string | null };
export function icCodes(m: IcMember): string[] {
  return [m.icReceivableCode, m.icPayableCode, m.icRevenueCode, m.icExpenseCode].filter((c): c is string => !!c);
}

export interface RuleInput {
  name: string;
  left: { orgId: string; code: string };
  right: { orgId: string; code: string };
  isActive?: boolean;
}

const MANAGERS: RoleName[] = ['OWNER', 'ADMIN'];
export const CONSOLIDATED_STATEMENTS = ['worksheet', 'income-statement', 'balance-sheet'] as const;
export type ConsolidatedStatement = (typeof CONSOLIDATED_STATEMENTS)[number];

/**
 * Groups of organisations and their consolidated statements. A group belongs to its parent
 * organisation; owners and admins of the parent set it up, and can add only organisations they
 * also own or administer. Reading the consolidation needs reports.read in the parent and in every
 * member: each member's figures are read inside that member's own tenant context, so row-level
 * security applies to them exactly as it does on the member's own reports.
 */
@Injectable()
export class ConsolidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reports: ReportsService,
  ) {}

  /** Runs work as if inside a request for another organisation the user belongs to. */
  private asOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return tenantStorage.run({ ...currentTenantContext(), orgId, inTx: false }, async () => await fn());
  }

  private async myRoles(userId: string): Promise<Map<string, RoleName>> {
    const ms = await this.prisma.membership.findMany({ where: { userId }, select: { orgId: true, role: true } });
    return new Map(ms.map((m) => [m.orgId, m.role as RoleName]));
  }

  private async orgNames(ids: string[]): Promise<Map<string, { name: string; currency: string }>> {
    const orgs = await this.prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, functionalCurrency: true } });
    return new Map(orgs.map((o) => [o.id, { name: o.name, currency: o.functionalCurrency }]));
  }

  private async group(org: OrgContext, id: string) {
    const g = await this.prisma.consolidationGroup.findFirst({
      where: { id, orgId: org.id },
      include: { members: { orderBy: { createdAt: 'asc' } }, rates: { orderBy: [{ periodEnd: 'desc' }] }, rules: { orderBy: { createdAt: 'asc' } } },
    });
    if (!g) throw new DomainError('NOT_FOUND', 'Group not found', HttpStatus.NOT_FOUND);
    return g;
  }

  async list(org: OrgContext) {
    const groups = await this.prisma.consolidationGroup.findMany({ where: { orgId: org.id }, include: { members: true, rules: true }, orderBy: { name: 'asc' } });
    const names = await this.orgNames([...new Set(groups.flatMap((g) => g.members.map((m) => m.memberOrgId)))]);
    return {
      items: groups.map((g) => ({
        id: g.id,
        name: g.name,
        currency: g.currency,
        members: g.members.map((m) => ({ orgId: m.memberOrgId, name: names.get(m.memberOrgId)?.name ?? null, currency: names.get(m.memberOrgId)?.currency ?? null })),
        rules: g.rules.length,
        updatedAt: g.updatedAt.toISOString(),
      })),
    };
  }

  async detail(org: OrgContext, userId: string, id: string) {
    const g = await this.group(org, id);
    const roles = await this.myRoles(userId);
    const memberIds = g.members.map((m) => m.memberOrgId);
    const candidatesIds = [...roles.entries()].filter(([oid, r]) => MANAGERS.includes(r) && !memberIds.includes(oid)).map(([oid]) => oid);
    const names = await this.orgNames([...memberIds, ...candidatesIds]);
    const nameOf = (oid: string) => names.get(oid)?.name ?? null;
    return {
      id: g.id,
      name: g.name,
      currency: g.currency,
      parentOrgId: g.orgId,
      members: g.members.map((m) => {
        const role = roles.get(m.memberOrgId) ?? null;
        return {
          orgId: m.memberOrgId,
          name: nameOf(m.memberOrgId),
          currency: names.get(m.memberOrgId)?.currency ?? null,
          isParent: m.memberOrgId === g.orgId,
          ownershipPercent: m.ownershipPercent.toFixed(),
          intercompanyAccounts: { receivable: m.icReceivableCode, payable: m.icPayableCode, revenue: m.icRevenueCode, expense: m.icExpenseCode },
          yourRole: role,
          canReadReports: !!role && hasPermission(role, 'reports.read'),
          addedAt: m.createdAt.toISOString(),
        };
      }),
      rates: g.rates.map((r) => ({
        id: r.id,
        memberOrgId: r.memberOrgId,
        memberName: nameOf(r.memberOrgId),
        periodEnd: fromDbDate(r.periodEnd),
        closing: r.closing.toFixed(),
        average: r.average.toFixed(),
        historical: r.historical.toFixed(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      rules: g.rules.map((r) => ({
        id: r.id,
        name: r.name,
        left: { orgId: r.leftOrgId, name: nameOf(r.leftOrgId), code: r.leftCode },
        right: { orgId: r.rightOrgId, name: nameOf(r.rightOrgId), code: r.rightCode },
        isActive: r.isActive,
      })),
      candidates: candidatesIds.map((oid) => ({ orgId: oid, name: nameOf(oid), currency: names.get(oid)?.currency ?? null })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      updatedAt: g.updatedAt.toISOString(),
    };
  }

  private checkCurrency(currency: string) {
    try {
      minorUnits(currency);
    } catch {
      throw new DomainError('VALIDATION_FAILED', `${currency} is not a supported currency`, HttpStatus.BAD_REQUEST);
    }
  }

  private async uniqueName(tx: Tx, orgId: string, name: string, exceptId?: string) {
    const clash = await tx.consolidationGroup.findFirst({ where: { orgId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new DomainError('DUPLICATE', `There is already a group called ${clash.name}`, HttpStatus.CONFLICT);
  }

  async create(org: OrgContext, actor: Actor, input: { name: string; currency?: string | null }) {
    const currency = input.currency ?? org.functionalCurrency;
    this.checkCurrency(currency);
    return this.prisma.$transaction(async (tx) => {
      await this.uniqueName(tx, org.id, input.name);
      const g = await tx.consolidationGroup.create({ data: { orgId: org.id, name: input.name, currency, createdById: actor.id } });
      // The parent is always a member.
      await tx.consolidationMember.create({ data: { orgId: org.id, groupId: g.id, memberOrgId: org.id, addedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.created', entityType: 'consolidation_group', entityId: g.id, data: { name: g.name, currency } });
      return { id: g.id };
    });
  }

  async update(org: OrgContext, actor: Actor, id: string, input: { name: string; currency: string }) {
    this.checkCurrency(input.currency);
    const g = await this.group(org, id);
    await this.prisma.$transaction(async (tx) => {
      await this.uniqueName(tx, org.id, input.name, id);
      await tx.consolidationGroup.update({ where: { id }, data: { name: input.name, currency: input.currency } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.updated', entityType: 'consolidation_group', entityId: id, data: { name: input.name, currency: input.currency, was: { name: g.name, currency: g.currency } } });
    });
    return { id };
  }

  async remove(org: OrgContext, actor: Actor, id: string) {
    const g = await this.group(org, id);
    if (await this.prisma.intercompanyTransaction.count({ where: { groupId: id, orgId: org.id } })) {
      throw new DomainError('GROUP_IN_USE', 'This group has intercompany transactions and cannot be deleted', HttpStatus.CONFLICT);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.eliminationRule.deleteMany({ where: { groupId: id, orgId: org.id } });
      await tx.consolidationGroup.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.deleted', entityType: 'consolidation_group', entityId: id, data: { name: g.name, members: g.members.length, rules: g.rules.length } });
    });
    return { deleted: true };
  }

  async addMember(org: OrgContext, actor: Actor, id: string, memberOrgId: string) {
    const g = await this.group(org, id);
    const role = (await this.myRoles(actor.id)).get(memberOrgId);
    // Not a member at all reads the same as an organisation that does not exist.
    if (!role) throw new DomainError('NOT_FOUND', 'Organization not found', HttpStatus.NOT_FOUND);
    if (!MANAGERS.includes(role)) throw new DomainError('FORBIDDEN', `Only an owner or admin of an organisation can add it to a group; your role there is ${role}`, HttpStatus.FORBIDDEN);
    if (g.members.some((m) => m.memberOrgId === memberOrgId)) throw new DomainError('DUPLICATE', 'That organisation is already in the group', HttpStatus.CONFLICT);
    const name = (await this.orgNames([memberOrgId])).get(memberOrgId)?.name ?? null;
    await this.prisma.$transaction(async (tx) => {
      await tx.consolidationMember.create({ data: { orgId: org.id, groupId: id, memberOrgId, addedById: actor.id } });
      await tx.consolidationGroup.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.member_added', entityType: 'consolidation_group', entityId: id, data: { memberOrgId, name } });
    });
    return this.detail(org, actor.id, id);
  }

  async setOwnership(org: OrgContext, actor: Actor, id: string, memberOrgId: string, ownershipPercent: string) {
    const g = await this.group(org, id);
    const m = g.members.find((x) => x.memberOrgId === memberOrgId);
    if (!m) throw new DomainError('NOT_FOUND', 'That organisation is not in the group', HttpStatus.NOT_FOUND);
    const issues = checkOwnershipPercent(ownershipPercent);
    if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!, HttpStatus.BAD_REQUEST);
    if (memberOrgId === org.id && !new D(ownershipPercent).eq(100)) {
      throw new DomainError('PARENT_MEMBER', 'The parent organisation always owns itself in full', HttpStatus.CONFLICT);
    }
    const before = m.ownershipPercent.toFixed();
    const after = new D(ownershipPercent).toFixed();
    if (before !== after) {
      await this.prisma.$transaction(async (tx) => {
        await tx.consolidationMember.update({ where: { groupId_memberOrgId: { groupId: id, memberOrgId } }, data: { ownershipPercent: after } });
        await tx.consolidationGroup.update({ where: { id }, data: { updatedAt: new Date() } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.ownership_changed', entityType: 'consolidation_group', entityId: id, data: { memberOrgId, before, after } });
      });
    }
    return this.detail(org, actor.id, id);
  }

  /**
   * The accounts a company uses for intercompany transactions. Postings to them through the
   * intercompany ledger are eliminated by their exact amounts, so no elimination rule may use them.
   */
  async setIntercompanyAccounts(org: OrgContext, actor: Actor, id: string, memberOrgId: string, input: IntercompanyAccountsInput) {
    const g = await this.group(org, id);
    const m = g.members.find((x) => x.memberOrgId === memberOrgId);
    if (!m) throw new DomainError('NOT_FOUND', 'That organisation is not in the group', HttpStatus.NOT_FOUND);
    const role = (await this.myRoles(actor.id)).get(memberOrgId);
    if (!role || !hasPermission(role, 'accounts.read')) throw new DomainError('FORBIDDEN', 'You cannot see the accounts of that organisation', HttpStatus.FORBIDDEN);
    const issues: string[] = [];
    const codes = Object.entries(input).filter(([, c]) => c) as [keyof IntercompanyAccountsInput, string][];
    if (new Set(codes.map(([, c]) => c)).size !== codes.length) issues.push('Use a different account for each purpose');
    for (const [k, code] of codes) {
      const acc = await this.asOrg(memberOrgId, async () => await this.prisma.account.findFirst({ where: { orgId: memberOrgId, code } }));
      if (!acc) issues.push(`There is no account ${code}`);
      else if (acc.type !== IC_ACCOUNT_TYPES[k]) issues.push(`The ${IC_LABELS[k]} account must be ${IC_ACCOUNT_TYPES[k].toLowerCase()} account; ${code} ${acc.name} is ${acc.type.toLowerCase()}`);
      else if (!acc.isActive || !acc.isPostable) issues.push(`${code} ${acc.name} is not an active posting account`);
    }
    const overlap = g.rules.filter((r) => (r.leftOrgId === memberOrgId && codes.some(([, c]) => c === r.leftCode)) || (r.rightOrgId === memberOrgId && codes.some(([, c]) => c === r.rightCode)));
    for (const r of overlap) issues.push(`Elimination rule "${r.name}" already uses one of these accounts; delete it first, because intercompany transactions are eliminated by their exact amounts`);
    if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const data = { icReceivableCode: input.receivable, icPayableCode: input.payable, icRevenueCode: input.revenue, icExpenseCode: input.expense };
    await this.prisma.$transaction(async (tx) => {
      await tx.consolidationMember.update({ where: { groupId_memberOrgId: { groupId: id, memberOrgId } }, data });
      await tx.consolidationGroup.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.intercompany_accounts_set', entityType: 'consolidation_group', entityId: id, data: { memberOrgId, ...input } });
    });
    return this.detail(org, actor.id, id);
  }

  async removeMember(org: OrgContext, actor: Actor, id: string, memberOrgId: string) {
    const g = await this.group(org, id);
    if (memberOrgId === org.id) throw new DomainError('PARENT_MEMBER', 'The parent organisation is always in its own group', HttpStatus.CONFLICT);
    if (!g.members.some((m) => m.memberOrgId === memberOrgId)) throw new DomainError('NOT_FOUND', 'That organisation is not in the group', HttpStatus.NOT_FOUND);
    if (await this.prisma.intercompanyTransaction.count({ where: { groupId: id, orgId: org.id, OR: [{ fromOrgId: memberOrgId }, { toOrgId: memberOrgId }] } })) {
      throw new DomainError('MEMBER_IN_USE', 'This company has intercompany transactions in the group and cannot be removed', HttpStatus.CONFLICT);
    }
    const used = g.rules.filter((r) => r.leftOrgId === memberOrgId || r.rightOrgId === memberOrgId);
    if (used.length) {
      throw new DomainError('MEMBER_IN_USE', 'Delete the elimination rules that use this organisation first', HttpStatus.CONFLICT, { issues: used.map((r) => r.name) });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.consolidationMember.delete({ where: { groupId_memberOrgId: { groupId: id, memberOrgId } } });
      await tx.consolidationGroup.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.member_removed', entityType: 'consolidation_group', entityId: id, data: { memberOrgId } });
    });
    return this.detail(org, actor.id, id);
  }

  async setRate(org: OrgContext, actor: Actor, id: string, input: RateInput) {
    const g = await this.group(org, id);
    if (!g.members.some((m) => m.memberOrgId === input.memberOrgId)) throw new DomainError('NOT_FOUND', 'That organisation is not in the group', HttpStatus.NOT_FOUND);
    const issues = checkTranslationRates(input);
    if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!, HttpStatus.BAD_REQUEST, { issues });
    const currency = (await this.orgNames([input.memberOrgId])).get(input.memberOrgId)?.currency;
    if (currency === g.currency) throw new DomainError('SAME_CURRENCY', `That organisation already keeps its books in ${g.currency}; it needs no rates`, HttpStatus.UNPROCESSABLE_ENTITY);
    const data = { closing: input.closing, average: input.average, historical: input.historical, updatedById: actor.id };
    await this.prisma.$transaction(async (tx) => {
      await tx.consolidationRate.upsert({
        where: { groupId_memberOrgId_periodEnd: { groupId: id, memberOrgId: input.memberOrgId, periodEnd: toDbDate(input.periodEnd) } },
        create: { orgId: org.id, groupId: id, memberOrgId: input.memberOrgId, periodEnd: toDbDate(input.periodEnd), ...data },
        update: data,
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.rates_set', entityType: 'consolidation_group', entityId: id, data: { ...input, from: currency, to: g.currency } });
    });
    return this.detail(org, actor.id, id);
  }

  async deleteRate(org: OrgContext, actor: Actor, id: string, rateId: string) {
    await this.group(org, id);
    const r = await this.prisma.consolidationRate.findFirst({ where: { id: rateId, groupId: id, orgId: org.id } });
    if (!r) throw new DomainError('NOT_FOUND', 'Rate not found', HttpStatus.NOT_FOUND);
    await this.prisma.$transaction(async (tx) => {
      await tx.consolidationRate.delete({ where: { id: rateId } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'consolidation_group.rates_deleted', entityType: 'consolidation_group', entityId: id, data: { memberOrgId: r.memberOrgId, periodEnd: fromDbDate(r.periodEnd) } });
    });
    return this.detail(org, actor.id, id);
  }

  /** Checks a rule's two accounts exist in their organisations (read in each one's own context). */
  private async checkRule(g: { members: ({ memberOrgId: string } & IcMember)[] }, userId: string, input: RuleInput) {
    const roles = await this.myRoles(userId);
    const issues: string[] = [];
    for (const [label, s] of [['first', input.left], ['second', input.right]] as const) {
      if (!g.members.some((m) => m.memberOrgId === s.orgId)) {
        issues.push(`The ${label} organisation is not in the group`);
        continue;
      }
      const role = roles.get(s.orgId);
      if (!role || !hasPermission(role, 'accounts.read')) {
        issues.push(`You cannot see the accounts of the ${label} organisation`);
        continue;
      }
      const acc = await this.asOrg(s.orgId, () => this.prisma.account.findFirst({ where: { orgId: s.orgId, code: s.code } }));
      if (!acc) issues.push(`The ${label} organisation has no account ${s.code}`);
    }
    if (input.left.orgId === input.right.orgId && input.left.code === input.right.code) issues.push('Pick two different accounts');
    for (const s of [input.left, input.right]) {
      const m = g.members.find((x) => x.memberOrgId === s.orgId);
      if (m && icCodes(m).includes(s.code)) issues.push(`Account ${s.code} is an intercompany account: its intercompany transactions are already eliminated by their exact amounts`);
    }
    if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }

  async addRule(org: OrgContext, actor: Actor, id: string, input: RuleInput) {
    const g = await this.group(org, id);
    await this.checkRule(g, actor.id, input);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.eliminationRule.create({
        data: { orgId: org.id, groupId: id, name: input.name, leftOrgId: input.left.orgId, leftCode: input.left.code, rightOrgId: input.right.orgId, rightCode: input.right.code, isActive: input.isActive ?? true, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'elimination_rule.created', entityType: 'elimination_rule', entityId: r.id, data: { groupId: id, ...input } });
    });
    return this.detail(org, actor.id, id);
  }

  async updateRule(org: OrgContext, actor: Actor, id: string, ruleId: string, input: RuleInput) {
    const g = await this.group(org, id);
    const r = g.rules.find((x) => x.id === ruleId);
    if (!r) throw new DomainError('NOT_FOUND', 'Rule not found', HttpStatus.NOT_FOUND);
    await this.checkRule(g, actor.id, input);
    await this.prisma.$transaction(async (tx) => {
      await tx.eliminationRule.update({
        where: { id: ruleId },
        data: { name: input.name, leftOrgId: input.left.orgId, leftCode: input.left.code, rightOrgId: input.right.orgId, rightCode: input.right.code, isActive: input.isActive ?? r.isActive },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'elimination_rule.updated', entityType: 'elimination_rule', entityId: ruleId, data: { groupId: id, ...input } });
    });
    return this.detail(org, actor.id, id);
  }

  async deleteRule(org: OrgContext, actor: Actor, id: string, ruleId: string) {
    const g = await this.group(org, id);
    const r = g.rules.find((x) => x.id === ruleId);
    if (!r) throw new DomainError('NOT_FOUND', 'Rule not found', HttpStatus.NOT_FOUND);
    await this.prisma.$transaction(async (tx) => {
      await tx.eliminationRule.delete({ where: { id: ruleId } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'elimination_rule.deleted', entityType: 'elimination_rule', entityId: ruleId, data: { groupId: id, name: r.name } });
    });
    return this.detail(org, actor.id, id);
  }

  /**
   * The consolidation worksheet and statements for a period. Every member's balances are read
   * through the same report service as its own trial balance, in its own tenant context.
   */
  async report(org: OrgContext, userId: string, id: string, q: { from: string; to: string }) {
    if (q.from > q.to) throw new DomainError('INVALID_RANGE', 'The start must be on or before the end date', HttpStatus.BAD_REQUEST);
    const g = await this.group(org, id);
    const roles = await this.myRoles(userId);
    const names = await this.orgNames(g.members.map((m) => m.memberOrgId));
    const blocked = g.members.filter((m) => {
      const role = roles.get(m.memberOrgId);
      return !role || !hasPermission(role, 'reports.read');
    });
    if (blocked.length) {
      throw new DomainError('FORBIDDEN', 'You need report access in every organisation of the group', HttpStatus.FORBIDDEN, {
        issues: blocked.map((m) => `No report access in ${names.get(m.memberOrgId)?.name ?? 'an organisation you are not a member of'}`),
      });
    }
    const periodEnd = toDbDate(q.to).getTime();
    const entities: ConsolidationEntity[] = [];
    for (const m of g.members) {
      const oid = m.memberOrgId;
      const [closing, period] = await this.asOrg(oid, async () => [await this.reports.trialBalance(oid, { asOf: q.to }), await this.reports.trialBalance(oid, { from: q.from, asOf: q.to })]);
      const signed = (rows: typeof closing.rows) => rows.map((r) => ({ code: r.code, name: r.name, type: r.type, netDebit: new D(r.netDebit).minus(r.netCredit).toFixed() }));
      const rate = g.rates.find((r) => r.memberOrgId === oid && r.periodEnd.getTime() === periodEnd);
      entities.push({
        id: oid,
        name: names.get(oid)?.name ?? oid,
        currency: closing.currency,
        closing: signed(closing.rows),
        period: signed(period.rows),
        rates: rate ? { closing: rate.closing.toFixed(), average: rate.average.toFixed(), historical: rate.historical.toFixed() } : null,
        ownershipPercent: m.ownershipPercent.toFixed(),
      });
    }
    const ic = await this.prisma.intercompanyTransaction.findMany({ where: { groupId: id, orgId: org.id, date: { lte: toDbDate(q.to) } }, orderBy: { number: 'asc' } });
    let result: ConsolidationResult;
    try {
      result = consolidate({
        currency: g.currency,
        entities,
        rules: g.rules.filter((r) => r.isActive).map((r) => ({ id: r.id, name: r.name, left: { entityId: r.leftOrgId, code: r.leftCode }, right: { entityId: r.rightOrgId, code: r.rightCode } })),
        ledger: intercompanyEliminations(
          ic.map((t) => ({
            id: t.id,
            kind: t.kind,
            fromEntityId: t.fromOrgId,
            toEntityId: t.toOrgId,
            date: fromDbDate(t.date),
            reversedOn: t.reversedOn ? fromDbDate(t.reversedOn) : null,
            amount: t.amount.toFixed(),
            toAmount: t.toAmount.toFixed(),
            fromReceivableCode: t.fromReceivableCode,
            toPayableCode: t.toPayableCode,
            fromRevenueCode: t.fromRevenueCode,
            toExpenseCode: t.toExpenseCode,
          })),
          q,
          new Map([...names.entries()].map(([k, v]) => [k, v.name])),
        ),
      });
    } catch (e) {
      if (e instanceof ConsolidationError) throw new DomainError('CONSOLIDATION_BLOCKED', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
    return { group: { id: g.id, name: g.name }, from: q.from, to: q.to, ...result };
  }

  async export(org: OrgContext, actor: Actor, id: string, statement: string, format: ExportFormat, q: { from: string; to: string }): Promise<ExportedFile> {
    if (!(CONSOLIDATED_STATEMENTS as readonly string[]).includes(statement)) {
      throw new DomainError('NOT_FOUND', `Choose a statement: ${CONSOLIDATED_STATEMENTS.join(', ')}`, HttpStatus.NOT_FOUND);
    }
    const r = await this.report(org, actor.id, id, q);
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { name: true } });
    const model = this.exportModel(statement as ConsolidatedStatement, r, `${r.group.name} (group of ${o.name})`);
    const file = await renderExportFile(model, format);
    await this.prisma.$transaction(async (tx) => {
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'report.exported',
        entityType: 'report',
        entityId: null,
        data: { report: `consolidated-${statement}`, groupId: id, format, params: q, fileName: file.fileName, bytes: file.body.length, sha256: file.sha256, rows: model.rows.length },
      });
    });
    return file;
  }

  private exportModel(statement: ConsolidatedStatement, r: Awaited<ReturnType<ConsolidationService['report']>>, orgName: string): ExportReport {
    const period = `${formatDate(r.from, 'DMY')} to ${formatDate(r.to, 'DMY')}`;
    const base = { orgName, period, currency: r.currency, generatedAt: new Date().toISOString() };
    const slug = r.group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const notes = [
      ...r.entities.map((e) => (e.rates ? `${e.name}: ${e.currency} translated at closing ${e.rates.closing}, average ${e.rates.average}, historical ${e.rates.historical}.` : `${e.name}: ${e.currency}.`)),
      ...r.entities
        .filter((e) => e.ownershipPercent !== '100')
        .map((e) => `${e.name} is ${e.ownershipPercent}% owned: non-controlling interests are ${e.nonControllingNetAssets} of its net assets and ${e.nonControllingProfit} of its profit, before goodwill and fair value adjustments.`),
      ...r.eliminations.filter((e) => !e.matched).map((e) => `Elimination "${e.name}" ${e.problem ? `could not be applied: ${e.problem}` : `leaves a difference of ${e.difference}`}.`),
    ];
    const hasNci = r.entities.some((e) => e.ownershipPercent !== '100');
    const label = (x: { code: string; name: string }) => [x.code || '', x.name] as [string, string];
    if (statement === 'worksheet') {
      return {
        ...base,
        title: 'Consolidation worksheet',
        columns: [
          { label: 'Code', type: 'text', width: 8 },
          { label: 'Account', type: 'text', width: 26 },
          ...r.entities.map((e) => ({ label: e.name, type: 'money' as const, width: 13 })),
          { label: 'Eliminations', type: 'money', width: 13 },
          { label: 'Consolidated', type: 'money', width: 13 },
        ],
        rows: [
          ...r.rows.map((x): ExportRow => ({ cells: [...label(x), ...x.amounts, x.elimination, x.consolidated] })),
          { cells: ['', 'Total', ...r.entities.map((_, i) => sumCol(r.rows.map((x) => x.amounts[i]!), r.currency)), sumCol(r.rows.map((x) => x.elimination), r.currency), sumCol(r.rows.map((x) => x.consolidated), r.currency)], style: 'total' },
        ],
        notes: ['Signed net balances: debits positive, credits negative. Revenue and expenses are for the period; balance sheet accounts are at its end.', ...notes],
        fileName: `${slug}-consolidation-worksheet-${r.to}`,
        landscape: true,
      };
    }
    const cols = [
      { label: 'Code', type: 'text' as const, width: 10 },
      { label: 'Account', type: 'text' as const, width: 44 },
      { label: 'Amount', type: 'money' as const, width: 16 },
    ];
    const lines = (xs: { code: string; name: string; amount: string }[]) => xs.map((x): ExportRow => ({ cells: [...label(x), x.amount] }));
    if (statement === 'income-statement') {
      const is = r.incomeStatement;
      return {
        ...base,
        title: 'Consolidated profit and loss',
        columns: cols,
        rows: [
          { cells: ['', 'Revenue', null], style: 'section' },
          ...lines(is.revenue),
          { cells: ['', 'Total revenue', is.totalRevenue], style: 'subtotal' },
          { cells: ['', 'Expenses', null], style: 'section' },
          ...lines(is.expenses),
          { cells: ['', 'Total expenses', is.totalExpenses], style: 'subtotal' },
          { cells: ['', is.netIncome.startsWith('-') ? 'Net loss' : 'Net profit', is.netIncome], style: 'total' },
          ...(hasNci
            ? [
                { cells: ['', 'Attributable to owners of the parent', is.attributableToOwners] },
                { cells: ['', 'Attributable to non-controlling interests', is.attributableToNonControlling] },
              ]
            : []),
        ],
        notes,
        fileName: `${slug}-consolidated-profit-and-loss-${r.from}-to-${r.to}`,
      };
    }
    const bs = r.balanceSheet;
    return {
      ...base,
      period: `As of ${formatDate(r.to, 'DMY')}`,
      title: 'Consolidated balance sheet',
      columns: cols,
      rows: [
        { cells: ['', 'Assets', null], style: 'section' },
        ...lines(bs.assets),
        { cells: ['', 'Total assets', bs.totalAssets], style: 'total' },
        { cells: ['', 'Liabilities', null], style: 'section' },
        ...lines(bs.liabilities),
        { cells: ['', 'Total liabilities', bs.totalLiabilities], style: 'subtotal' },
        { cells: ['', 'Equity', null], style: 'section' },
        ...lines(bs.equity),
        { cells: ['', 'Profit for the period', bs.periodEarnings] },
        ...(hasNci
          ? [
              { cells: ['', 'Equity attributable to owners of the parent', bs.equityAttributableToOwners], style: 'subtotal' as const },
              { cells: ['', 'Non-controlling interests', bs.nonControllingInterests] },
            ]
          : []),
        { cells: ['', 'Total equity', bs.totalEquity], style: 'subtotal' },
        { cells: ['', 'Total liabilities and equity', addMoney(bs.totalLiabilities, bs.totalEquity, r.currency)], style: 'total' },
      ],
      notes,
      fileName: `${slug}-consolidated-balance-sheet-${r.to}`,
    };
  }
}

function sumCol(xs: string[], currency: string): string {
  return xs.reduce((a, x) => a.plus(x), new D(0)).toFixed(minorUnits(currency));
}
function addMoney(a: string, b: string, currency: string): string {
  return new D(a).plus(b).toFixed(minorUnits(currency));
}
