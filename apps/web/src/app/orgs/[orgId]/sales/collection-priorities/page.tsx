'use client';
import { useQuery } from '@tanstack/react-query';
import type { CollectionAction } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Priority {
  contactId: string;
  name: string;
  email: string | null;
  creditHold: boolean;
  rank: number;
  score: number;
  action: CollectionAction;
  actionLabel: string;
  open: string;
  overdue: string;
  disputed: string;
  toChase: string;
  oldestOverdueDays: number;
  overdueInvoices: number;
  lastReminderOn: string | null;
  factors: { key: string; label: string; points: number; max: number; detail: string }[];
  invoices: { id: string; number: string; dueDate: string; outstanding: string; lateChance: number; disputed: string }[];
}
interface Priorities {
  asOf: string;
  currency: string;
  summary: { customers: number; toChase: string; disputed: string; callNow: number };
  customers: Priority[];
}

const TONE: Record<CollectionAction, 'negative' | 'warning' | 'accent' | 'neutral' | 'violet'> = { CALL_AND_HOLD: 'negative', CALL: 'negative', REMIND: 'warning', NUDGE: 'accent', WAIT: 'neutral', SETTLE_DISPUTE: 'violet' };

/** Intelligent collection prioritisation (AR-034): who to chase first today, and how. */
export default function CollectionPrioritiesPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['collection-priorities', orgId], queryFn: () => api<Priorities>(`/v1/orgs/${orgId}/collection-priorities`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Collection priorities"
        description="Who to chase first today and how: overdue money not in dispute, how old it is, the chance of paying late and when each customer was last reminded. Nothing here changes the books."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/collections`}>Draft reminders</Link>}
      />
      <ErrorAlert title="Could not load collection priorities" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Customers to chase" value={d.summary.customers} />
            <Stat label="Overdue, not disputed" value={<Money value={d.summary.toChase} currency={c} />} tone="warning" />
            <Stat label="In dispute" value={<Money value={d.summary.disputed} currency={c} />} tone="violet" sub="Left out of what to chase" />
            <Stat label="Call today" value={d.summary.callNow} tone={d.summary.callNow ? 'negative' : 'positive'} sub="Over 30 days past due" />
          </div>
          <Card>
            <CardHeader title="Who to chase first" description="Highest score first. Open a row's score to see the points behind it." />
            {!d.customers.length ? (
              <EmptyState title="Nobody to chase">No customer has an overdue balance or an invoice due this week that is likely to be late.</EmptyState>
            ) : (
              <Table aria-label="Collection priorities">
                <thead><Tr><Th numeric>#</Th><Th>Customer</Th><Th>Suggested action</Th><Th numeric>To chase</Th><Th>Oldest overdue</Th><Th>Last reminder</Th><Th>Score</Th></Tr></thead>
                <tbody>
                  {d.customers.map((p) => (
                    <Tr key={p.contactId}>
                      <Td numeric>{p.rank}</Td>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${p.contactId}`}>{p.name}</Link>
                        {p.creditHold ? <div><Badge tone="negative">On credit hold</Badge></div> : null}
                        <div className="text-xs text-fg-muted">{p.invoices.map((i) => i.number).join(', ')}</div>
                      </Td>
                      <Td><Badge tone={TONE[p.action]}>{p.actionLabel}</Badge></Td>
                      <Td numeric><Money value={p.toChase} currency={c} />{!/^0(\.0+)?$/.test(p.disputed) ? <div className="text-xs text-fg-muted">plus <Money value={p.disputed} currency={c} /> disputed</div> : null}</Td>
                      <Td>{p.oldestOverdueDays ? `${p.oldestOverdueDays} days` : <span className="text-fg-muted">Not yet due</span>}</Td>
                      <Td>{p.lastReminderOn ? date(p.lastReminderOn) : <span className="text-fg-muted">Never</span>}</Td>
                      <Td>
                        <details>
                          <summary className="cursor-pointer font-mono">{p.score} / 100</summary>
                          <ul className="mt-1 space-y-0.5 text-xs">
                            {p.factors.map((f) => <li key={f.key}><span className="font-mono">{f.points}/{f.max}</span> {f.label}: {f.detail}</li>)}
                          </ul>
                        </details>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
