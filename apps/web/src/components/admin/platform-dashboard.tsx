'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';
import { monthLabel } from '@/lib/kpis';

type Level = 'HIGH' | 'MEDIUM' | 'LOW';
type UsageState = 'OK' | 'NEAR' | 'REACHED' | 'UNLIMITED';
export interface PlatformDashboard {
  asOf: string;
  organisations: { total: number; suspended: number; demo: number; createdLast30Days: number; countries: { countryCode: string; organisations: number }[] };
  people: { total: number; disabled: number; joinedLast30Days: number; signedInLast30Days: number };
  growth: { month: string; organisations: number; people: number }[];
  subscriptions: {
    byState: { state: string; organisations: number }[];
    paying: number;
    readOnly: number;
    runRate: { currency: string; monthly: string; annual: string; subscriptions: number }[];
    requests: { orgId: string; organisation: string; plan: string; interval: string | null; at: string }[];
    trialsEnding: { orgId: string; organisation: string; plan: string | null; trialEndsAt: string | null }[];
  };
  usage: {
    month: string;
    totals: { aiCalls: number; tokens: number; uploads: number; bytes: number; atLimit: number; nearLimit: number };
    fullest: {
      orgId: string;
      organisation: string;
      plan: string | null;
      ai: { used: number; limit: number | null; percent: number | null; state: UsageState };
      uploads: { used: number; limit: number | null; percent: number | null; state: UsageState };
    }[];
  };
  support: {
    open: number;
    pending: number;
    overdue: number;
    queue: { id: string; reference: string; subject: string; organisation: string; status: string; priority: string; next: { state: string } }[];
  };
  operations: {
    errorGroupsOpen: number;
    errorsLastHour: number;
    securityAlertsOpen: number;
    securityEvents24h: { HIGH: number; MEDIUM: number };
    backups: { lastBackupAt: string | null; lastDrillAt: string | null; problems: string[] };
  };
  administrators: { id: string; name: string; platformRole: string }[];
  attention: { title: string; detail: string; level: Level; href: string }[];
}

const TONE = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' } as const;
const STATE: Record<string, string> = {
  TRIAL: 'On trial',
  ACTIVE: 'Paid and active',
  GRACE: 'In grace period',
  CANCELLING: 'Cancelling at period end',
  COMPLIMENTARY: 'Complimentary',
  TRIAL_ENDED: 'Trial ended (read-only)',
  LAPSED: 'Lapsed (read-only)',
  CANCELLED: 'Cancelled (read-only)',
};
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : 'Never';
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
const share = (u: { used: number; limit: number | null; percent: number | null }) => (u.limit === null ? `${u.used} (no limit)` : `${u.used} of ${u.limit} (${u.percent ?? 0}%)`);

/** New organisations and people each month as bars; the table under it has the figures. */
export function GrowthBars({ months }: { months: PlatformDashboard['growth'] }) {
  const s = chartSeries;
  return (
    <div className="h-56 w-full px-2" role="img" aria-label="New organisations and new people each month as bars; the same figures are in the table below">
      <ResponsiveContainer>
        <BarChart data={months.map((m) => ({ month: monthLabel(m.month), organisations: m.organisations, people: m.people }))} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
          <Tooltip />
          <Legend />
          <Bar dataKey="organisations" name="New organisations" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="people" name="New people" fill={s[4]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PlatformDashboardView({ d }: { d: PlatformDashboard }) {
  return (
    <div className="grid gap-4">
      <Card role="region" aria-label="Platform to-do">
        <CardHeader title="Platform to-do" description="Security, backups, late tickets, errors, plan requests and limits across the service, most urgent first." />
        {d.attention.length ? (
          <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Platform items">
            {d.attention.map((a) => (
              <li key={a.title} className="flex items-start gap-2 px-5 py-2.5">
                <Badge tone={TONE[a.level]}>{a.level.toLowerCase()}</Badge>
                <span>
                  <Link className="text-accent hover:underline" href={a.href}>
                    {a.title}
                  </Link>
                  <span className="block text-xs text-fg-muted">{a.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-fg-muted">Nothing needs the platform team right now.</p>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Growth by month">
          <CardHeader
            title="Growth by month"
            description="Organisations created and people who registered in each of the last six months."
            actions={
              <Link className="text-sm text-accent hover:underline" href="/admin/organisations">
                Organisations
              </Link>
            }
          />
          <GrowthBars months={d.growth} />
          <Table aria-label="New each month">
            <thead>
              <Tr>
                <Th>Month</Th>
                <Th numeric>Organisations</Th>
                <Th numeric>People</Th>
              </Tr>
            </thead>
            <tbody>
              {d.growth.map((m) => (
                <Tr key={m.month}>
                  <Td>{monthLabel(m.month)}</Td>
                  <Td numeric>{m.organisations}</Td>
                  <Td numeric>{m.people}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Subscriptions and run-rate">
          <CardHeader
            title="Subscriptions and run-rate"
            description={`${d.subscriptions.paying} paying, ${d.subscriptions.readOnly} read-only. Run-rate counts paid, active subscriptions of real organisations; an annual price counts as a twelfth a month.`}
            actions={
              <Link className="text-sm text-accent hover:underline" href="/admin/subscriptions">
                Subscriptions
              </Link>
            }
          />
          <Table aria-label="Run-rate by currency">
            <thead>
              <Tr>
                <Th>Currency</Th>
                <Th numeric>Paying</Th>
                <Th numeric>A month</Th>
                <Th numeric>A year</Th>
              </Tr>
            </thead>
            <tbody>
              {d.subscriptions.runRate.length ? (
                d.subscriptions.runRate.map((r) => (
                  <Tr key={r.currency}>
                    <Td>{r.currency}</Td>
                    <Td numeric>{r.subscriptions}</Td>
                    <Td numeric>{money(r.monthly, r.currency)}</Td>
                    <Td numeric>{money(r.annual, r.currency)}</Td>
                  </Tr>
                ))
              ) : (
                <Tr>
                  <Td colSpan={4} className="text-fg-muted">
                    No paying subscription yet.
                  </Td>
                </Tr>
              )}
            </tbody>
          </Table>
          <Table aria-label="Subscriptions by state">
            <thead>
              <Tr>
                <Th>State</Th>
                <Th numeric>Organisations</Th>
              </Tr>
            </thead>
            <tbody>
              {d.subscriptions.byState.map((s) => (
                <Tr key={s.state}>
                  <Td>{STATE[s.state] ?? s.state}</Td>
                  <Td numeric>{s.organisations}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {d.subscriptions.requests.length || d.subscriptions.trialsEnding.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Plan requests and trials ending">
              {d.subscriptions.requests.map((r) => (
                <li key={`r-${r.orgId}`} className="flex justify-between gap-2 px-5 py-2.5">
                  <Link className="text-accent hover:underline" href={`/admin/organisations/${r.orgId}`}>
                    {r.organisation}
                  </Link>
                  <span className="text-fg-muted">
                    asked for {r.plan}
                    {r.interval ? `, ${r.interval.toLowerCase()}` : ''}
                  </span>
                </li>
              ))}
              {d.subscriptions.trialsEnding.map((t) => (
                <li key={`t-${t.orgId}`} className="flex justify-between gap-2 px-5 py-2.5">
                  <Link className="text-accent hover:underline" href={`/admin/organisations/${t.orgId}`}>
                    {t.organisation}
                  </Link>
                  <span className="text-fg-muted">trial ends {day(t.trialEndsAt)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Fullest organisations this month">
          <CardHeader
            title="Fullest organisations this month"
            description={`${d.usage.totals.aiCalls} AI requests and ${d.usage.totals.uploads} uploads across the service in ${monthLabel(d.usage.month)}; ${d.usage.totals.atLimit} organisations at a limit and ${d.usage.totals.nearLimit} near one.`}
            actions={
              <Link className="text-sm text-accent hover:underline" href="/admin/usage">
                Usage
              </Link>
            }
          />
          {d.usage.fullest.length ? (
            <Table aria-label="Organisations by use">
              <thead>
                <Tr>
                  <Th>Organisation</Th>
                  <Th>AI requests</Th>
                  <Th>Uploads</Th>
                </Tr>
              </thead>
              <tbody>
                {d.usage.fullest.map((o) => (
                  <Tr key={o.orgId}>
                    <Td>
                      <Link className="text-accent hover:underline" href={`/admin/organisations/${o.orgId}`}>
                        {o.organisation}
                      </Link>
                      <span className="block text-xs text-fg-muted">{o.plan ?? 'No plan'}</span>
                    </Td>
                    <Td className={o.ai.state === 'REACHED' ? 'text-negative' : undefined}>{share(o.ai)}</Td>
                    <Td className={o.uploads.state === 'REACHED' ? 'text-negative' : undefined}>{share(o.uploads)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="px-5 py-4 text-sm text-fg-muted">No organisation has used AI or uploads this month.</p>
          )}
        </Card>
        <Card role="region" aria-label="Organisations by country">
          <CardHeader title="Organisations by country" description={`${d.organisations.total} organisations, ${d.organisations.demo} of them demo and ${d.organisations.suspended} suspended.`} />
          <Table aria-label="Countries">
            <thead>
              <Tr>
                <Th>Country</Th>
                <Th numeric>Organisations</Th>
              </Tr>
            </thead>
            <tbody>
              {d.organisations.countries.map((c) => (
                <Tr key={c.countryCode}>
                  <Td>{c.countryCode}</Td>
                  <Td numeric>{c.organisations}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Tickets to answer">
          <CardHeader
            title="Tickets to answer"
            description={`${d.support.open} open and ${d.support.pending} waiting on the customer; ${d.support.overdue} past their target. Most urgent first.`}
            actions={
              <Link className="text-sm text-accent hover:underline" href="/admin/support">
                Support
              </Link>
            }
          />
          {d.support.queue.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Most urgent tickets">
              {d.support.queue.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2 px-5 py-2.5">
                  <span>
                    <Link className="text-accent hover:underline" href={`/admin/support/${t.id}`}>
                      {t.reference} · {t.subject}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {t.organisation}, {t.priority.toLowerCase()} priority
                    </span>
                  </span>
                  {t.next.state === 'OVERDUE' ? <Badge tone="negative">overdue</Badge> : <Badge tone="neutral">{t.status.toLowerCase()}</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-fg-muted">No ticket is open.</p>
          )}
        </Card>
        <Card role="region" aria-label="Service operations">
          <CardHeader
            title="Service operations"
            description="Errors, security and backups across the service."
            actions={
              <Link className="text-sm text-accent hover:underline" href="/admin/system">
                System health
              </Link>
            }
          />
          <Table aria-label="Operations">
            <tbody>
              <Tr>
                <Td>
                  <Link className="text-accent hover:underline" href="/admin/errors">
                    Error groups open
                  </Link>
                </Td>
                <Td numeric>{d.operations.errorGroupsOpen}</Td>
              </Tr>
              <Tr>
                <Td>Errors in the last hour</Td>
                <Td numeric>{d.operations.errorsLastHour}</Td>
              </Tr>
              <Tr>
                <Td>
                  <Link className="text-accent hover:underline" href="/admin/security">
                    Security alerts open
                  </Link>
                </Td>
                <Td numeric>{d.operations.securityAlertsOpen}</Td>
              </Tr>
              <Tr>
                <Td>Security events, last 24 hours (high / medium)</Td>
                <Td numeric>
                  {d.operations.securityEvents24h.HIGH} / {d.operations.securityEvents24h.MEDIUM}
                </Td>
              </Tr>
              <Tr>
                <Td>
                  <Link className="text-accent hover:underline" href="/admin/backups">
                    Last backup
                  </Link>
                </Td>
                <Td numeric>{when(d.operations.backups.lastBackupAt)}</Td>
              </Tr>
              <Tr>
                <Td>Last restore drill</Td>
                <Td numeric>{when(d.operations.backups.lastDrillAt)}</Td>
              </Tr>
            </tbody>
          </Table>
          {d.operations.backups.problems.length ? <p className="px-5 py-3 text-sm text-negative">{d.operations.backups.problems.join('. ')}.</p> : null}
        </Card>
      </div>
    </div>
  );
}
