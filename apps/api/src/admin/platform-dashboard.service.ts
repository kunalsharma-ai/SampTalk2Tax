import { Injectable } from '@nestjs/common';
import { monthlyRunRate, platformAttention } from '@talk2tax/accounting-engine';
import type { AuthUser } from '../auth/decorators';
import { BackupsService } from '../backups/backups.service';
import { PlatformBillingService } from '../billing/platform-billing.service';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, withSystemAccess } from '../common/prisma.service';
import { users as usersCollection } from '../db/collections/identity';
import { ErrorsService } from '../operations/errors.service';
import { SecurityMonitorService } from '../security-monitor/security-monitor.service';
import { SupportService } from '../support/support.service';
import { UsageService } from '../usage/usage.service';
import { AdminService } from './admin.service';

const DAY_MS = 86_400_000;

/** The months from five before this one up to this one, as YYYY-MM (UTC). */
function lastSixMonths(now: Date) {
  const out: string[] = [];
  for (let i = 5; i >= 0; i--) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}

/**
 * The global super admin's dashboard (DASH-042): the health of the whole service in one place.
 * Like the rest of platform administration it reads organisation metadata, subscriptions, usage
 * counts, support, errors, security and backups, never an organisation's books.
 */
@Injectable()
export class PlatformDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly admin: AdminService,
    private readonly billing: PlatformBillingService,
    private readonly usage: UsageService,
    private readonly support: SupportService,
    private readonly errors: ErrorsService,
    private readonly security: SecurityMonitorService,
    private readonly backups: BackupsService,
  ) {}

  async dashboard(user: AuthUser, now = new Date()) {
    const months = lastSixMonths(now);
    const since = new Date(`${months[0]}-01T00:00:00Z`);
    const [overview, subs, usage, support, errors, security, backups, orgs, people] = await Promise.all([
      this.admin.overview(now),
      this.billing.subscriptions('all', now),
      this.usage.platform(),
      this.support.queue(user, { status: 'active', assigned: 'all' }, now),
      this.errors.counts(),
      this.security.report(),
      this.backups.status(now),
      this.prisma.$transaction((tx) => withSystemAccess(tx, () => tx.organization.findMany({ select: { createdAt: true, countryCode: true, isDemo: true } }))),
      this.store.collection(usersCollection).find({ createdAt: { $gte: since } }, { projection: { createdAt: 1 } }),
    ]);
    const tickets = support.counts as { overdue: number } & Record<string, number>;
    const count = <T>(rows: T[], f: (r: T) => boolean) => rows.filter(f).length;
    const growth = months.map((m) => ({
      month: m,
      organisations: count(orgs, (o) => o.createdAt.toISOString().slice(0, 7) === m),
      people: count(people, (p) => p.createdAt.toISOString().slice(0, 7) === m),
    }));
    const countries = [...new Set(orgs.map((o) => o.countryCode))].sort().map((c) => ({ countryCode: c, organisations: count(orgs, (o) => o.countryCode === c) }));
    const states = ['TRIAL', 'ACTIVE', 'GRACE', 'CANCELLING', 'COMPLIMENTARY', 'TRIAL_ENDED', 'LAPSED', 'CANCELLED'];
    const byState = states.map((state) => ({ state, organisations: count(subs, (s) => s.access.state === state) })).filter((s) => s.organisations > 0);
    const paying = (s: (typeof subs)[number]) => !s.isDemo && s.status === 'ACTIVE' && s.access.level === 'FULL';
    const runRate = monthlyRunRate(subs.map((s) => ({ currency: s.currency, price: s.price, billingInterval: s.billingInterval as 'MONTHLY' | 'ANNUAL' | null, paying: paying(s) })));
    const weekAhead = now.getTime() + 7 * DAY_MS;
    const trialsEnding = subs.filter((s) => s.access.state === 'TRIAL' && s.trialEndsAt && Date.parse(s.trialEndsAt) <= weekAhead);
    const requests = subs.filter((s) => s.request);
    const readOnly = count(subs, (s) => s.access.level === 'READ_ONLY');
    const facts = {
      securityAlertsOpen: security.openAlerts,
      highSecurityEvents24h: security.last24Hours.HIGH,
      errorGroupsOpen: errors.open,
      errorsLastHour: errors.lastHour,
      backupProblems: backups.problems,
      supportOverdue: support.counts.overdue,
      supportOpen: (tickets.OPEN ?? 0) + (tickets.PENDING ?? 0),
      planRequests: requests.length,
      trialsEndingSoon: trialsEnding.length,
      readOnly,
      atLimit: usage.totals.atLimit,
      suspended: overview.organisations.suspended,
    };
    return {
      asOf: now.toISOString(),
      organisations: { ...overview.organisations, countries },
      people: overview.people,
      growth,
      subscriptions: {
        byState,
        paying: count(subs, paying),
        readOnly,
        runRate,
        requests: requests.slice(0, 6).map((s) => ({ orgId: s.orgId, organisation: s.organisation, plan: s.request!.plan.name, interval: s.request!.interval, at: s.request!.at })),
        trialsEnding: trialsEnding.slice(0, 6).map((s) => ({ orgId: s.orgId, organisation: s.organisation, plan: s.plan?.name ?? null, trialEndsAt: s.trialEndsAt })),
      },
      usage: {
        month: usage.month,
        totals: usage.totals,
        fullest: usage.organisations
          .slice(0, 5)
          .map((o) => ({
            orgId: o.org.id,
            organisation: o.org.name,
            plan: o.plan?.name ?? null,
            ai: { used: o.ai.used, limit: o.ai.limit, percent: o.ai.percent, state: o.ai.state },
            uploads: { used: o.uploads.used, limit: o.uploads.limit, percent: o.uploads.percent, state: o.uploads.state },
          })),
      },
      support: {
        open: tickets.OPEN ?? 0,
        pending: tickets.PENDING ?? 0,
        overdue: support.counts.overdue,
        queue: support.tickets.slice(0, 5).map((t) => ({ id: t.id, reference: t.reference, subject: t.subject, organisation: t.org.name, status: t.status, priority: t.priority, next: t.next })),
      },
      operations: {
        errorGroupsOpen: errors.open,
        errorsLastHour: errors.lastHour,
        securityAlertsOpen: security.openAlerts,
        securityEvents24h: security.last24Hours,
        backups: { lastBackupAt: backups.lastBackup?.at ?? null, lastDrillAt: backups.lastDrill?.at ?? null, problems: backups.problems },
      },
      administrators: overview.administrators.map((a) => ({ id: a.id, name: a.name, platformRole: a.platformRole })),
      attention: platformAttention(facts),
    };
  }
}
