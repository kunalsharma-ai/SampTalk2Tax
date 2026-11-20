import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { users } from '../db/collections/identity';
import { AccessRuleDoc, accessRules } from '../db/collections/security';
import { memberships } from '../db/collections/tenancy';

/**
 * Attribute-based access control (SEC-004). Roles say what a person may do; access rules add
 * where and when: from which networks and on which days and hours (in the organisation's time
 * zone) the people a rule names may open the books, or change anything in them. Every active rule
 * that names a person must be met. Owners are never bound, so an organisation cannot lock itself
 * out, and a rule that would refuse the person saving it is refused.
 */
export const BINDABLE_ROLES = ['ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER', 'EMPLOYEE'] as const;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface AccessRuleInput {
  name: string;
  roles: string[];
  userIds: string[];
  appliesTo: 'ALL' | 'CHANGES';
  networks: string[];
  days: number[];
  startMinute: number | null;
  endMinute: number | null;
  active: boolean;
}

/** What a request looks like to the rules: who, from where, when, and whether it changes anything. */
export interface AccessAttempt {
  userId: string;
  role: string;
  ip: string | null;
  at: Date;
  timeZone: string;
  writes: boolean;
}

type Rule = Pick<AccessRuleDoc, 'id' | 'name' | 'roles' | 'userIds' | 'appliesTo' | 'networks' | 'days' | 'startMinute' | 'endMinute' | 'active'>;

/** An IPv4-mapped IPv6 address (::ffff:10.1.2.3) is checked as the IPv4 address it carries. */
export function plainIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return isIP(v) ? v : null;
}

/** A network as written by a person: an address or a CIDR range. Null when it is neither. */
export function parseNetwork(text: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [address, bits, extra] = text.trim().split('/');
  if (extra !== undefined) return null;
  const family = isIP(address);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

export function inNetworks(ip: string | null, networks: string[]): boolean {
  if (!networks.length) return true;
  const v = plainIp(ip);
  if (!v) return false;
  const list = new BlockList();
  for (const n of networks) {
    const p = parseNetwork(n);
    if (p) list.addSubnet(p.address, p.prefix, p.family);
  }
  return list.check(v, isIP(v) === 4 ? 'ipv4' : 'ipv6');
}

/** Day of the week (0 = Sunday) and minutes after midnight at that moment in the time zone. */
export function localTime(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function inHours(minute: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null) return true;
  // A window past midnight (22:00 to 06:00) wraps.
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Why this rule refuses the attempt, or null when it allows it (or does not bind the person). */
export function refusal(rule: Rule, a: AccessAttempt): string | null {
  if (!rule.active || a.role === 'OWNER') return null;
  if (!rule.roles.includes(a.role) && !rule.userIds.includes(a.userId)) return null;
  if (rule.appliesTo === 'CHANGES' && !a.writes) return null;
  if (!inNetworks(a.ip, rule.networks)) return `"${rule.name}" allows ${rule.appliesTo === 'CHANGES' ? 'changes' : 'access'} only from the organisation's listed networks${a.ip ? ` (this request came from ${plainIp(a.ip) ?? a.ip})` : ''}`;
  const t = localTime(a.at, a.timeZone);
  if (rule.days.length && !rule.days.includes(t.day)) return `"${rule.name}" allows ${rule.appliesTo === 'CHANGES' ? 'changes' : 'access'} only on ${rule.days.map((d) => DAY_NAMES[d]).join(', ')}`;
  if (!inHours(t.minute, rule.startMinute, rule.endMinute)) return `"${rule.name}" allows ${rule.appliesTo === 'CHANGES' ? 'changes' : 'access'} only from ${hhmm(rule.startMinute!)} to ${hhmm(rule.endMinute!)} (${a.timeZone})`;
  return null;
}

@Injectable()
export class AccessRulesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Refuses the request (403 ACCESS_RULE) when an active rule that binds the person is not met. */
  async assertAllowed(orgId: string, a: AccessAttempt): Promise<void> {
    if (a.role === 'OWNER') return;
    const rules = await runInOrg(orgId, () => this.store.collection(accessRules).find({ active: true }));
    for (const r of rules) {
      const why = refusal(r, a);
      if (why) throw new ForbiddenException({ error: 'ACCESS_RULE', message: `This organisation's access rule ${why}. Ask an owner or admin if you need access.`, rule: r.name });
    }
  }

  /**
   * For the list of a person's organisations: why opening each one now would be refused, so the
   * web app can say so instead of showing empty pages. Owners and organisations without rules: none.
   */
  async refusalsFor(userId: string, ip: string | null, orgs: { orgId: string; role: string; timeZone: string }[]): Promise<Map<string, string>> {
    const bound = orgs.filter((o) => o.role !== 'OWNER');
    const out = new Map<string, string>();
    if (!bound.length) return out;
    const rules = await runAsSystem(() => this.store.collection(accessRules).find({ orgId: { $in: bound.map((o) => o.orgId) }, active: true }));
    const at = new Date();
    for (const o of bound) {
      for (const r of rules.filter((x) => x.orgId === o.orgId)) {
        const why = refusal(r, { userId, role: o.role, ip, at, timeZone: o.timeZone, writes: false });
        if (why) {
          out.set(o.orgId, `This organisation's access rule ${why}.`);
          break;
        }
      }
    }
    return out;
  }

  async list(orgId: string, you: Omit<AccessAttempt, 'writes'>) {
    const rows = await runInOrg(orgId, () => this.store.collection(accessRules).find({}, { sort: { createdAt: 1 } }));
    const ms = await runInOrg(orgId, () => this.store.collection(memberships).find({}));
    const people = new Map((await this.store.collection(users).find({ id: { $in: ms.map((m) => m.userId) } })).map((u) => [u.id, u.name]));
    const local = localTime(you.at, you.timeZone);
    return {
      rules: rows.map((r) => ({
        ...this.view(r),
        people: r.userIds.map((id) => ({ id, name: people.get(id) ?? 'Former member' })),
        // Whether it would refuse the person looking, now: a read, and a change.
        refusesYou: { access: refusal(r, { ...you, writes: false }), changes: refusal(r, { ...you, writes: true }) },
      })),
      you: { ip: plainIp(you.ip), role: you.role, localTime: hhmm(local.minute), day: DAY_NAMES[local.day], timeZone: you.timeZone },
      members: ms.filter((m) => m.role !== 'OWNER').map((m) => ({ id: m.userId, name: people.get(m.userId) ?? 'Unknown', role: m.role })),
    };
  }

  async create(orgId: string, actor: Omit<AccessAttempt, 'writes'>, input: AccessRuleInput) {
    await this.check(orgId, actor, input);
    const now = new Date();
    const row = await runInOrg(orgId, () => this.store.collection(accessRules).insertOne({ orgId, ...this.clean(input), createdById: actor.userId, updatedById: actor.userId, createdAt: now, updatedAt: now }));
    await this.record(orgId, actor.userId, 'access_rule.created', row.id, this.view(row));
    return this.view(row);
  }

  async update(orgId: string, actor: Omit<AccessAttempt, 'writes'>, id: string, input: AccessRuleInput) {
    const before = await this.find(orgId, id);
    await this.check(orgId, actor, input);
    const after = this.clean(input);
    await runInOrg(orgId, () => this.store.collection(accessRules).updateOne({ id }, { $set: { ...after, updatedById: actor.userId, updatedAt: new Date() } }));
    await this.record(orgId, actor.userId, 'access_rule.updated', id, { before: this.view(before), after: { id, ...after } });
    return this.view(await this.find(orgId, id));
  }

  async remove(orgId: string, actorId: string, id: string) {
    const before = await this.find(orgId, id);
    await runInOrg(orgId, () => this.store.collection(accessRules).deleteOne({ id }));
    await this.record(orgId, actorId, 'access_rule.deleted', id, this.view(before));
    return { deleted: true };
  }

  private async find(orgId: string, id: string) {
    const r = await runInOrg(orgId, () => this.store.collection(accessRules).findById(id));
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Access rule not found' });
    return r;
  }

  /** A rule must bind someone, name real networks and members, and not refuse the person saving it. */
  private async check(orgId: string, actor: Omit<AccessAttempt, 'writes'>, input: AccessRuleInput) {
    const problems: string[] = [];
    if (!input.roles.length && !input.userIds.length) problems.push('Choose the roles or people the rule applies to');
    if (!input.networks.length && !input.days.length && input.startMinute === null) problems.push('Give at least one condition: networks, days or hours');
    const bad = input.networks.filter((n) => !parseNetwork(n));
    if (bad.length) problems.push(`Not an IP address or range: ${bad.join(', ')}`);
    if ((input.startMinute === null) !== (input.endMinute === null)) problems.push('Give both a start and an end time, or neither');
    if (input.startMinute !== null && input.startMinute === input.endMinute) problems.push('The start and end time must differ');
    if (input.userIds.length) {
      const ms = await runInOrg(orgId, () => this.store.collection(memberships).find({ userId: { $in: input.userIds } }));
      const found = new Map(ms.map((m) => [m.userId, m.role]));
      if (input.userIds.some((u) => !found.has(u))) problems.push('Some of the people chosen are not members');
      if (input.userIds.some((u) => found.get(u) === 'OWNER')) problems.push('Owners cannot be bound by access rules');
    }
    if (problems.length) throw new DomainError('VALIDATION', problems.join('. '), HttpStatus.UNPROCESSABLE_ENTITY, { problems });
    const self = refusal({ id: '', ...this.clean(input) }, { ...actor, writes: true });
    if (input.active && self) throw new DomainError('ACCESS_RULE_LOCKS_YOU_OUT', `Saving this would lock you out: the rule ${self}. Change it, or leave it switched off.`, HttpStatus.CONFLICT);
  }

  private clean(i: AccessRuleInput) {
    return {
      name: i.name.trim(),
      roles: [...new Set(i.roles)],
      userIds: [...new Set(i.userIds)],
      appliesTo: i.appliesTo,
      networks: [...new Set(i.networks.map((n) => n.trim()))],
      days: [...new Set(i.days)].sort(),
      startMinute: i.startMinute,
      endMinute: i.endMinute,
      active: i.active,
    };
  }

  private view(r: Rule & { createdAt?: Date; updatedAt?: Date }) {
    return { id: r.id, name: r.name, roles: r.roles, userIds: r.userIds, appliesTo: r.appliesTo, networks: r.networks, days: r.days, startMinute: r.startMinute, endMinute: r.endMinute, active: r.active, updatedAt: r.updatedAt ?? null };
  }

  private record(orgId: string, actorId: string, action: string, id: string, data: unknown) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'access_rule', entityId: id, data: data as Record<string, unknown> }));
  }
}
