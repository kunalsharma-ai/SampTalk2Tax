import { D } from './money';

/** The global super admin's dashboard (DASH-042): subscription run-rate and what needs the platform team first. */

export type PlatformLevel = 'HIGH' | 'MEDIUM' | 'LOW';
const ORDER: Record<PlatformLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export interface RunRateSubscription {
  currency: string;
  price: string | null;
  billingInterval: 'MONTHLY' | 'ANNUAL' | null;
  paying: boolean;
}

/** Monthly recurring revenue by currency: paying subscriptions only, an annual price counted as a twelfth a month. */
export function monthlyRunRate(subs: RunRateSubscription[]): { currency: string; monthly: string; annual: string; subscriptions: number }[] {
  const by = new Map<string, { monthly: InstanceType<typeof D>; n: number }>();
  for (const s of subs) {
    if (!s.paying || s.price === null || !s.billingInterval) continue;
    const price = new D(s.price);
    const monthly = s.billingInterval === 'ANNUAL' ? price.dividedBy(12) : price;
    const r = by.get(s.currency) ?? { monthly: new D(0), n: 0 };
    by.set(s.currency, { monthly: r.monthly.plus(monthly), n: r.n + 1 });
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, r]) => ({
      currency,
      monthly: r.monthly.toDecimalPlaces(2, D.ROUND_HALF_EVEN).toFixed(2),
      annual: r.monthly.times(12).toDecimalPlaces(2, D.ROUND_HALF_EVEN).toFixed(2),
      subscriptions: r.n,
    }));
}

export interface PlatformFacts {
  securityAlertsOpen: number;
  highSecurityEvents24h: number;
  errorGroupsOpen: number;
  errorsLastHour: number;
  backupProblems: string[];
  supportOverdue: number;
  supportOpen: number;
  planRequests: number;
  trialsEndingSoon: number;
  readOnly: number;
  atLimit: number;
  suspended: number;
}

/** What the platform team should look at, most urgent first; each links to the admin page where it is handled. */
export function platformAttention(f: PlatformFacts): { title: string; detail: string; level: PlatformLevel; href: string }[] {
  const out: { title: string; detail: string; level: PlatformLevel; href: string }[] = [];
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (f.securityAlertsOpen > 0)
    out.push({ title: 'Security alerts open', detail: `${s(f.securityAlertsOpen, 'alert is', 'alerts are')} not yet acknowledged.`, level: 'HIGH', href: '/admin/security' });
  for (const p of f.backupProblems) out.push({ title: 'Backups need attention', detail: `${p}.`, level: 'HIGH', href: '/admin/backups' });
  if (f.supportOverdue > 0)
    out.push({ title: 'Support tickets past their target', detail: `${s(f.supportOverdue, 'ticket is', 'tickets are')} late for a response or resolution.`, level: 'HIGH', href: '/admin/support' });
  if (f.errorsLastHour > 0)
    out.push({
      title: 'Server errors in the last hour',
      detail: `${s(f.errorsLastHour, 'error was', 'errors were')} recorded; ${f.errorGroupsOpen} error groups are open.`,
      level: f.errorsLastHour >= 10 ? 'HIGH' : 'MEDIUM',
      href: '/admin/errors',
    });
  else if (f.errorGroupsOpen > 0) out.push({ title: 'Error groups not resolved', detail: `${s(f.errorGroupsOpen, 'group is', 'groups are')} still open.`, level: 'LOW', href: '/admin/errors' });
  if (f.highSecurityEvents24h > 0)
    out.push({ title: 'High-severity security events today', detail: `${s(f.highSecurityEvents24h, 'event', 'events')} in the last 24 hours.`, level: 'MEDIUM', href: '/admin/security' });
  if (f.planRequests > 0)
    out.push({
      title: 'Plan requests waiting',
      detail: `${s(f.planRequests, 'organisation asked', 'organisations asked')} for a plan; activate it once paid.`,
      level: 'MEDIUM',
      href: '/admin/subscriptions',
    });
  if (f.atLimit > 0)
    out.push({
      title: 'Organisations at a plan limit',
      detail: `${s(f.atLimit, 'organisation has', 'organisations have')} used all of this month's AI requests or uploads.`,
      level: 'MEDIUM',
      href: '/admin/usage',
    });
  if (f.trialsEndingSoon > 0) out.push({ title: 'Trials ending this week', detail: `${s(f.trialsEndingSoon, 'trial ends', 'trials end')} within 7 days.`, level: 'LOW', href: '/admin/subscriptions' });
  if (f.readOnly > 0)
    out.push({
      title: 'Organisations read-only',
      detail: `${s(f.readOnly, 'organisation is', 'organisations are')} read-only after a trial ended or a subscription lapsed.`,
      level: 'LOW',
      href: '/admin/subscriptions',
    });
  if (f.supportOpen > 0 && f.supportOverdue === 0)
    out.push({ title: 'Support tickets open', detail: `${s(f.supportOpen, 'ticket is', 'tickets are')} open or waiting, all within target.`, level: 'LOW', href: '/admin/support' });
  if (f.suspended > 0) out.push({ title: 'Suspended organisations', detail: `${s(f.suspended, 'organisation is', 'organisations are')} suspended.`, level: 'LOW', href: '/admin/organisations' });
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.title.localeCompare(b.title));
}
