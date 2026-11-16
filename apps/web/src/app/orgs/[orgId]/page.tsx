'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageHeader } from '@/components/shell';
import { Money } from '@/components/money';
import { PeriodChart, type PeriodPoint } from '@/components/period-chart';
import { api } from '@/lib/api';
import { date, isNegative, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type ComplianceCalendar, type Journal } from '@/lib/types';

interface Dashboard {
  currency: string;
  asOf: string;
  fiscalYear: number;
  fiscalYearStart: string;
  balances: { cash: string; receivables: string; payables: string };
  yearToDate: { revenue: string; expenses: string; netIncome: string };
  periods: (PeriodPoint & { periodId: string; status: string })[];
  draftJournals: number;
}

export default function DashboardPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const employee = org?.role === 'EMPLOYEE';
  useEffect(() => {
    if (employee) router.replace(`/orgs/${orgId}/expenses`);
  }, [employee, orgId, router]);
  const asOf = today();
  const dash = useQuery({ enabled: !!org && !employee, queryKey: ['dashboard', orgId, asOf], queryFn: () => api<Dashboard>(`/v1/orgs/${orgId}/reports/dashboard?asOf=${asOf}`) });
  const recent = useQuery({ enabled: !!org && !employee, queryKey: ['journals', orgId, 'recent'], queryFn: () => api<{ items: Journal[] }>(`/v1/orgs/${orgId}/journals?limit=6`) });
  if (!org || employee) return null;
  const d = dash.data;
  const c = org.functionalCurrency;
  const hasActivity = d && d.periods.some((p) => p.revenue !== '0.00' || p.expenses !== '0.00' || p.closingCash !== '0.00');

  return (
    <>
      <PageHeader
        title={org.name}
        description={d ? `FY${d.fiscalYear} to date · as of ${date(asOf)} · all figures from posted journals in ${c}` : 'Loading figures…'}
        actions={
          can(org.role, 'journals.create') ? (
            <Link href={`/orgs/${orgId}/journals/new`}>
              <Button>New journal</Button>
            </Link>
          ) : null
        }
      />
      {dash.error ? <Alert title="Could not load the dashboard">{(dash.error as Error).message}</Alert> : null}
      {d ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Cash and bank" value={<Money value={d.balances.cash} currency={c} signed />} tone="accent" sub="Balance of cash and bank accounts" />
            <Stat label="Receivables" value={<Money value={d.balances.receivables} currency={c} />} tone="violet" sub={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/ageing`}>Owed to you · ageing</Link>} />
            <Stat label="Payables" value={<Money value={d.balances.payables} currency={c} />} tone="warning" sub={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/ageing`}>You owe suppliers · ageing</Link>} />
            <Stat
              label="Net income YTD"
              value={<Money value={d.yearToDate.netIncome} currency={c} signed />}
              tone={isNegative(d.yearToDate.netIncome) ? 'negative' : 'positive'}
              sub={
                <>
                  Revenue <Money value={d.yearToDate.revenue} currency={c} /> · Expenses <Money value={d.yearToDate.expenses} currency={c} />
                </>
              }
            />
          </div>
          {d.draftJournals > 0 ? (
            <div className="mt-4">
              <Alert tone="warning" title={`${d.draftJournals} draft journal${d.draftJournals === 1 ? '' : 's'} not yet posted`}>
                Drafts do not affect any balance until they are posted.{' '}
                <Link className="text-accent underline" href={`/orgs/${orgId}/journals?status=DRAFT`}>
                  Review drafts
                </Link>
              </Alert>
            </div>
          ) : null}
          {org.countryCode === 'IN' && can(org.role, 'reports.read') ? <ComplianceStrip orgId={orgId} /> : null}
          <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader title="Revenue, expenses and cash by month" description={`Fiscal year ${d.fiscalYear}, from ${date(d.fiscalYearStart)}`} />
              <div className="p-4">
                {hasActivity ? (
                  <>
                    <PeriodChart data={d.periods} currency={c} />
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">Show the figures as a table</summary>
                      <Table className="mt-2">
                        <thead>
                          <tr>
                            <Th>Period</Th>
                            <Th numeric>Revenue</Th>
                            <Th numeric>Expenses</Th>
                            <Th numeric>Net income</Th>
                            <Th numeric>Closing cash</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.periods.map((p) => (
                            <Tr key={p.periodId}>
                              <Td>{p.name}</Td>
                              <Td numeric><Money value={p.revenue} currency={c} /></Td>
                              <Td numeric><Money value={p.expenses} currency={c} /></Td>
                              <Td numeric><Money value={p.netIncome} currency={c} signed /></Td>
                              <Td numeric><Money value={p.closingCash} currency={c} signed /></Td>
                            </Tr>
                          ))}
                        </tbody>
                      </Table>
                    </details>
                  </>
                ) : (
                  <EmptyState title="No posted activity yet">Post your first journal and this chart will fill in from your ledger.</EmptyState>
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="Recent journals" actions={<Link className="text-xs text-accent hover:underline" href={`/orgs/${orgId}/journals`}>View all</Link>} />
              <ul className="divide-y divide-line/60">
                {(recent.data?.items ?? []).map((j) => (
                  <li key={j.id}>
                    <Link href={`/orgs/${orgId}/journals/${j.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-hover/60">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-fg">{j.memo || 'Untitled journal'}</p>
                        <p className="text-xs text-fg-muted">
                          {j.displayNumber ?? 'Draft'} · {date(j.date)}
                        </p>
                      </div>
                      <div className="text-right">
                        <Money value={j.totalDebit} currency={c} className="text-sm" />
                        <div>{j.status === 'DRAFT' ? <Badge tone="warning">Draft</Badge> : j.type === 'REVERSING' ? <Badge tone="violet">Reversal</Badge> : null}</div>
                      </div>
                    </Link>
                  </li>
                ))}
                {recent.data && recent.data.items.length === 0 ? <li className="px-5 py-6 text-sm text-fg-muted">No journals yet.</li> : null}
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}

/** What falls due in the next two weeks, and anything overdue, from the compliance calendar. */
function ComplianceStrip({ orgId }: { orgId: string }) {
  const from = today();
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['compliance', orgId, from, to], queryFn: () => api<ComplianceCalendar>(`/v1/orgs/${orgId}/compliance/calendar?from=${from}&to=${to}`) });
  const c = q.data;
  if (!c || !c.configured) return null;
  const open = [...c.overdueBefore, ...c.items].filter((i) => i.status === 'OVERDUE' || i.status === 'DUE_SOON' || i.status === 'UPCOMING');
  return (
    <Card className="mt-4">
      <CardHeader
        title="Compliance"
        description={c.summary.overdue ? `${c.summary.overdue} overdue · ${c.summary.dueSoon} due within 7 days` : c.summary.dueSoon ? `${c.summary.dueSoon} due within 7 days` : 'Nothing overdue'}
        actions={<Link className="text-xs text-accent hover:underline" href={`/orgs/${orgId}/tax/compliance`}>Open calendar</Link>}
      />
      {open.length ? (
        <ul className="divide-y divide-line/60">
          {open.slice(0, 5).map((i) => (
            <li key={i.key} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span className="min-w-0 truncate">{i.name} · <span className="text-fg-muted">{i.periodLabel}</span></span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="num text-fg-muted">{date(i.dueDate)}</span>
                <Badge tone={i.status === 'OVERDUE' ? 'negative' : i.status === 'DUE_SOON' ? 'warning' : 'neutral'}>{i.status === 'OVERDUE' ? 'Overdue' : i.status === 'DUE_SOON' ? 'Due soon' : 'Upcoming'}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-fg-muted">Everything due in the next two weeks is done.</p>
      )}
    </Card>
  );
}
