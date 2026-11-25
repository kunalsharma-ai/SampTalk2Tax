import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@talk2tax/database';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { MailerService } from '../workflows/email';

/**
 * Security event monitoring (SEC-023). The audit trail already records every sign-in, lockout,
 * two-step failure, role change and refused file; this reads it for the people who run Talk2Tax:
 * - a feed of security events, each with a severity;
 * - alerts, when rules below find something that needs a person, emailed to every platform
 *   super admin once and kept until someone acknowledges them.
 */

export type Severity = 'HIGH' | 'MEDIUM';

/** Audit actions that are security events, with how serious each is and how to name it. */
export const SECURITY_EVENTS: Record<string, { severity: Severity; title: string }> = {
  'user.sign_in_locked': { severity: 'HIGH', title: 'Sign-in locked after failed passwords' },
  'user.mfa_challenge_failed': { severity: 'HIGH', title: 'Right password, wrong two-step codes' },
  'user.mfa_disabled': { severity: 'HIGH', title: 'Two-step sign-in turned off' },
  'sso.sign_in_refused': { severity: 'HIGH', title: 'Single sign-on refused' },
  'file.refused': { severity: 'HIGH', title: 'Upload refused' },
  'platform.role_changed': { severity: 'HIGH', title: 'Platform administrator role changed' },
  'platform.user_disabled': { severity: 'HIGH', title: 'Person disabled by a platform administrator' },
  'platform.secrets_resealed': { severity: 'HIGH', title: 'Stored secrets re-encrypted' },
  'platform.ai_stopped': { severity: 'HIGH', title: 'AI stopped for everyone' },
  'ai.emergency_stop': { severity: 'MEDIUM', title: "AI stopped for an organisation" },
  'user.mfa_recovery_code_used': { severity: 'MEDIUM', title: 'Two-step recovery code used' },
  'user.password_changed': { severity: 'MEDIUM', title: 'Password changed' },
  'session.new_device': { severity: 'MEDIUM', title: 'Sign-in from a new device' },
  'session.revoked_many': { severity: 'MEDIUM', title: 'Sessions signed out' },
  'api_key.created': { severity: 'MEDIUM', title: 'API key created' },
  'member.role_changed': { severity: 'MEDIUM', title: "Member's role changed" },
  'member.removed': { severity: 'MEDIUM', title: 'Member removed' },
  'sso.connection_saved': { severity: 'MEDIUM', title: 'Single sign-on settings changed' },
  'sso.connection_removed': { severity: 'MEDIUM', title: 'Single sign-on removed' },
  'retention.policy_changed': { severity: 'MEDIUM', title: 'Data retention changed' },
  'integration.removed': { severity: 'MEDIUM', title: 'Integration removed' },
  'platform.org_suspended': { severity: 'MEDIUM', title: 'Organisation suspended' },
  'platform.ai_models_changed': { severity: 'MEDIUM', title: 'Allowed AI models changed' },
};
const ACTIONS = Object.keys(SECURITY_EVENTS);

/** The rules that raise alerts. */
export const ALERT_RULES = {
  MANY_LOCKOUTS: 'Many sign-ins locked within an hour: someone may be guessing passwords',
  MFA_CODE_FAILURES: 'Someone had a password right but failed the two-step codes',
  PLATFORM_ROLE_CHANGED: 'A platform administrator role was given or changed',
  ADMIN_MFA_OFF: 'A platform administrator turned two-step sign-in off',
  INFECTED_UPLOAD: 'A file with a virus signature was uploaded',
  SSO_REFUSALS: 'Many single sign-ons refused within an hour',
} as const;
export type AlertRule = keyof typeof ALERT_RULES;

type Event = { id: bigint; orgId: string | null; actorId: string | null; action: string; entityId: string | null; data: unknown; createdAt: Date };
type Finding = { rule: AlertRule; key: string; severity: Severity; title: string; detail: string; orgId: string | null; userId: string | null; events: Event[] };

/** How far back each check looks: the rules count within an hour, so two hours covers a missed run. */
const LOOK_BACK_MS = 2 * 3_600_000;
const hourOf = (d: Date) => d.toISOString().slice(0, 13);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const dataOf = (e: Event) => (e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {});

@Injectable()
export class SecurityMonitorService {
  private readonly logger = new Logger('SecurityMonitor');
  lastRun: { at: string; alertsOpened: number; eventsRead: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** What the rules find in these events. */
  findings(events: Event[], admins: Set<string>): Finding[] {
    const out: Finding[] = [];
    const group = (list: Event[], key: (e: Event) => string) => {
      const m = new Map<string, Event[]>();
      for (const e of list) m.set(key(e), [...(m.get(key(e)) ?? []), e]);
      return m;
    };
    const of = (action: string) => events.filter((e) => e.action === action);

    for (const [hour, list] of group(of('user.sign_in_locked'), (e) => hourOf(e.createdAt))) {
      if (list.length < this.config.SECURITY_LOCKOUT_ALERT_COUNT) continue;
      const ips = [...new Set(list.map((e) => dataOf(e).ip).filter(Boolean))];
      out.push({ rule: 'MANY_LOCKOUTS', key: hour, severity: 'HIGH', title: `${list.length} sign-ins locked in one hour`, detail: `${list.length} people's sign-ins were locked after failed passwords between ${hour.slice(11)}:00 and ${hour.slice(11)}:59 UTC on ${hour.slice(0, 10)}, from ${ips.length || 'unknown'} address${ips.length === 1 ? '' : 'es'}${ips.length ? ` (${ips.slice(0, 5).join(', ')}${ips.length > 5 ? ', …' : ''})` : ''}.`, orgId: null, userId: null, events: list });
    }
    for (const [key, list] of group(of('user.mfa_challenge_failed'), (e) => `${e.entityId}:${dayOf(e.createdAt)}`)) {
      out.push({ rule: 'MFA_CODE_FAILURES', key, severity: 'HIGH', title: 'Right password, wrong two-step codes', detail: `Someone signed in with this person's password but then failed the two-step code too many times (${list.length} time${list.length === 1 ? '' : 's'} on ${key.split(':')[1]}). Their password may be known to someone else.`, orgId: null, userId: list[0]!.entityId, events: list });
    }
    for (const e of of('platform.role_changed')) {
      const d = dataOf(e);
      out.push({ rule: 'PLATFORM_ROLE_CHANGED', key: String(e.id), severity: 'HIGH', title: 'Platform administrator role changed', detail: `Platform role changed from ${d.before ?? 'none'} to ${d.after ?? 'none'}${d.via ? ` (${String(d.via)})` : ''}.`, orgId: null, userId: e.entityId, events: [e] });
    }
    for (const e of of('user.mfa_disabled').filter((x) => x.entityId && admins.has(x.entityId))) {
      out.push({ rule: 'ADMIN_MFA_OFF', key: String(e.id), severity: 'HIGH', title: 'A platform administrator turned two-step sign-in off', detail: 'A platform administrator can now sign in with a password alone.', orgId: null, userId: e.entityId, events: [e] });
    }
    for (const e of of('file.refused').filter((x) => dataOf(x).result === 'INFECTED')) {
      const d = dataOf(e);
      out.push({ rule: 'INFECTED_UPLOAD', key: String(e.id), severity: 'HIGH', title: 'File with a virus signature uploaded', detail: `${String(d.fileName ?? 'A file')} was refused: ${String(d.detail ?? 'virus signature found')}. It was not kept.`, orgId: e.orgId, userId: e.actorId, events: [e] });
    }
    for (const [key, list] of group(of('sso.sign_in_refused'), (e) => `${e.orgId}:${hourOf(e.createdAt)}`)) {
      if (list.length < 5) continue;
      out.push({ rule: 'SSO_REFUSALS', key, severity: 'MEDIUM', title: `${list.length} single sign-ons refused in one hour`, detail: `Single sign-on into this organisation was refused ${list.length} times in one hour (${[...new Set(list.map((e) => String(dataOf(e).reason ?? 'refused')))].slice(0, 3).join('; ')}).`, orgId: list[0]!.orgId, userId: null, events: list });
    }
    return out;
  }

  /** Reads the recent audit trail, opens or updates alerts, and emails platform super admins about new ones. */
  async scan(now = new Date()) {
    const events = (await runAsSystem(() =>
      this.prisma.auditEvent.findMany({ where: { action: { in: ACTIONS }, createdAt: { gte: new Date(now.getTime() - LOOK_BACK_MS) } }, orderBy: { createdAt: 'asc' }, select: { id: true, orgId: true, actorId: true, action: true, entityId: true, data: true, createdAt: true } }),
    )) as Event[];
    const admins = await this.prisma.user.findMany({ where: { platformRole: { not: null } }, select: { id: true, email: true, platformRole: true } });
    const opened: string[] = [];
    for (const f of this.findings(events, new Set(admins.map((a) => a.id)))) {
      const ids = f.events.map((e) => String(e.id)).slice(-50);
      const first = f.events[0]!.createdAt;
      const last = f.events.at(-1)!.createdAt;
      const existing = await runAsSystem(() => this.prisma.securityAlert.findUnique({ where: { rule_key: { rule: f.rule, key: f.key } } }));
      if (!existing) {
        // Another server may open the same alert at the same moment (PERF-019): the unique rule and
        // key let one of them win, and the other leaves it, so the alert and its email happen once.
        const a = await runAsSystem(() => this.prisma.securityAlert.create({ data: { rule: f.rule, key: f.key, severity: f.severity, title: f.title, detail: f.detail, orgId: f.orgId, userId: f.userId, eventIds: ids, count: f.events.length, firstSeenAt: first, lastSeenAt: last } })).catch((e: unknown) => {
          if (isDuplicateKeyError(e) || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) return null;
          throw e;
        });
        if (!a) continue;
        opened.push(a.id);
        await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: null, actorId: null, action: 'security.alert_opened', entityType: 'security_alert', entityId: a.id, data: { rule: f.rule, severity: f.severity, events: f.events.length } }));
      } else if (f.events.length > existing.count) {
        await runAsSystem(() => this.prisma.securityAlert.update({ where: { id: existing.id }, data: { title: f.title, detail: f.detail, eventIds: ids, count: f.events.length, lastSeenAt: last } }));
      }
    }
    for (const id of opened) await this.notify(id, admins.filter((a) => a.platformRole === 'SUPER_ADMIN').map((a) => a.email));
    this.lastRun = { at: now.toISOString(), alertsOpened: opened.length, eventsRead: events.length };
    if (opened.length) this.logger.warn(`${opened.length} new security alert(s)`);
    return this.lastRun;
  }

  /** One email per new alert to every platform super admin, through Talk2Tax's own mail server. */
  private async notify(alertId: string, to: string[]) {
    const a = await runAsSystem(() => this.prisma.securityAlert.findUniqueOrThrow({ where: { id: alertId } }));
    if (!to.length) {
      await runAsSystem(() => this.prisma.securityAlert.update({ where: { id: a.id }, data: { notifyError: 'No platform super admin to email' } }));
      return;
    }
    const link = `${this.config.APP_URL.replace(/\/$/, '')}/admin/security`;
    const r = await this.mailer.sendAsTalk2Tax({
      to,
      subject: `[Talk2Tax security] ${a.severity === 'HIGH' ? 'High' : 'Medium'}: ${a.title}`,
      text: `${a.title}\n\n${a.detail}\n\nFirst seen ${a.firstSeenAt.toISOString()}, ${a.count} event${a.count === 1 ? '' : 's'}.\n\nReview and acknowledge it at ${link}\n\nTalk2Tax security monitoring`,
      messageId: `<security-${createHash('sha256').update(a.id).digest('hex').slice(0, 24)}@talk2tax>`,
    });
    await runAsSystem(() => this.prisma.securityAlert.update({ where: { id: a.id }, data: r.ok ? { notifiedAt: new Date(), notifyError: null } : { notifyError: (r.error ?? 'Not sent').slice(0, 500) } }));
  }

  /** For platform administrators: open and recent alerts, and the last 7 days of security events. */
  async report(filter: { severity?: Severity } = {}) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [alerts, events] = await Promise.all([
      runAsSystem(() => this.prisma.securityAlert.findMany({ where: { OR: [{ status: 'OPEN' }, { lastSeenAt: { gte: since } }] }, orderBy: [{ lastSeenAt: 'desc' }], take: 100 })),
      runAsSystem(() => this.prisma.auditEvent.findMany({ where: { action: { in: filter.severity ? ACTIONS.filter((a) => SECURITY_EVENTS[a]!.severity === filter.severity) : ACTIONS }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 200 })),
    ]);
    const userIds = [...new Set([...alerts.flatMap((a) => [a.userId, a.acknowledgedById]), ...events.flatMap((e) => [e.actorId, e.entityType === 'user' ? e.entityId : null])].filter((x): x is string => !!x))];
    const orgIds = [...new Set([...alerts.map((a) => a.orgId), ...events.map((e) => e.orgId)].filter((x): x is string => !!x))];
    const [users, orgs] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
      runAsSystem(() => this.prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })),
    ]);
    const person = new Map(users.map((u) => [u.id, `${u.name} (${u.email})`]));
    const org = new Map(orgs.map((o) => [o.id, o.name]));
    const counts = { HIGH: 0, MEDIUM: 0 };
    const day = Date.now() - 86_400_000;
    for (const e of events) if (e.createdAt.getTime() >= day) counts[SECURITY_EVENTS[e.action]!.severity]++;
    return {
      monitor: { intervalSeconds: this.config.SECURITY_MONITOR_INTERVAL_SECONDS, lastRun: this.lastRun, lockoutAlertCount: this.config.SECURITY_LOCKOUT_ALERT_COUNT },
      last24Hours: counts,
      openAlerts: alerts.filter((a) => a.status === 'OPEN').length,
      alerts: alerts.map((a) => ({
        id: a.id,
        rule: a.rule,
        ruleName: ALERT_RULES[a.rule as AlertRule] ?? a.rule,
        severity: a.severity as Severity,
        title: a.title,
        detail: a.detail,
        organisation: a.orgId ? (org.get(a.orgId) ?? 'Former organisation') : null,
        person: a.userId ? (person.get(a.userId) ?? 'Former user') : null,
        count: a.count,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
        status: a.status as 'OPEN' | 'ACKNOWLEDGED',
        acknowledgedBy: a.acknowledgedById ? (person.get(a.acknowledgedById) ?? 'Former administrator') : null,
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
        note: a.note,
        emailed: a.notifiedAt ? a.notifiedAt.toISOString() : null,
        emailError: a.notifyError,
      })),
      events: events.map((e) => ({
        id: String(e.id),
        at: e.createdAt.toISOString(),
        action: e.action,
        severity: SECURITY_EVENTS[e.action]!.severity,
        title: SECURITY_EVENTS[e.action]!.title,
        organisation: e.orgId ? (org.get(e.orgId) ?? 'Former organisation') : null,
        by: e.actorId ? (person.get(e.actorId) ?? 'Former user') : null,
        person: e.entityType === 'user' && e.entityId ? (person.get(e.entityId) ?? null) : null,
        ip: typeof dataOf(e as Event).ip === 'string' ? (dataOf(e as Event).ip as string) : null,
      })),
    };
  }

  async acknowledge(actor: { id: string }, id: string, note: string) {
    const a = await runAsSystem(() => this.prisma.securityAlert.findUnique({ where: { id } }));
    if (!a) throw new DomainError('NOT_FOUND', 'No such security alert', HttpStatus.NOT_FOUND);
    if (a.status !== 'OPEN') throw new DomainError('ALERT_ALREADY_ACKNOWLEDGED', 'This alert is already acknowledged', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.securityAlert.update({ where: { id }, data: { status: 'ACKNOWLEDGED', acknowledgedById: actor.id, acknowledgedAt: new Date(), note } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'security.alert_acknowledged', entityType: 'security_alert', entityId: id, data: { rule: a.rule, note } });
    });
    return this.report();
  }
}
