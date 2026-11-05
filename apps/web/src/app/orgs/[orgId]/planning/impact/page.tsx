'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { AREA_LABEL, type AssessmentItem, type Options } from '@/lib/impact';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** Business impact engine: start from a business change, and saved assessments re-run on the latest books. */
export default function ImpactPage() {
  const { org, orgId } = useOrg();
  const opts = useQuery({ queryKey: ['impact-options', orgId, 6, 12], queryFn: () => api<Options>(`/v1/orgs/${orgId}/impact/options?baselineMonths=6&horizonMonths=12`) });
  const list = useQuery({ queryKey: ['impact-assessments', orgId], queryFn: () => api<{ items: AssessmentItem[] }>(`/v1/orgs/${orgId}/impact/assessments`) });
  if (!org) return null;
  const c = opts.data?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Business impact"
        description="What a change in sales, people, procurement or operations does to revenue, margins, profit and cash. Each change is built from your own books (your cost of sales ratio, your customers and suppliers) and played forward with the digital twin. Nothing is posted."
        actions={<Link className="rounded-[var(--t2t-radius-md)] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${orgId}/planning/impact/new`}>New assessment</Link>}
      />
      <ErrorAlert title="Could not load the business impact engine" error={opts.error ?? list.error} />
      <Card>
        <CardHeader title="Start from a business change" description="Pick one to open an assessment with figures sized to your books; add more changes from any area before assessing." />
        {opts.data ? (
          <div className="grid gap-4 px-5 pb-5 md:grid-cols-2 xl:grid-cols-4">
            {opts.data.areas.map((a) => (
              <section key={a.key} aria-label={a.label}>
                <h3 className="mb-2 text-sm font-medium">{a.label}</h3>
                <ul className="space-y-2">
                  {opts.data!.levers.filter((l) => l.area === a.key).map((l) => (
                    <li key={l.key}>
                      <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/impact/new?lever=${l.key}`}>{l.label}</Link>
                      <p className="text-xs text-fg-muted">{l.description}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : !opts.error ? (
          <p className="px-5 pb-5 text-sm text-fg-muted">Loading…</p>
        ) : null}
      </Card>

      <Card className="mt-4">
        <CardHeader title="Saved assessments" description={can(org.role, 'scenarios.manage') ? 'Saved with their changes; every visit re-runs them on the latest books.' : 'Saved with their changes; every visit re-runs them on the latest books. Saving needs permission to manage scenarios.'} />
        {list.data?.items.length ? (
          <Table aria-label="Saved assessments">
            <thead>
              <tr>
                <Th>Assessment</Th>
                <Th>Areas</Th>
                <Th>Changes</Th>
                <Th numeric>Net profit today</Th>
                <Th numeric>Cash at the end</Th>
                <Th>Changed</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/planning/impact/${s.id}`}>{s.name}</Link>
                    <p className="num text-xs text-fg-muted">{s.number} · {s.horizonMonths} months</p>
                  </Td>
                  <Td><span className="flex flex-wrap gap-1">{s.areas.map((a) => <Badge key={a} tone="neutral">{AREA_LABEL[a]}</Badge>)}</span></Td>
                  <Td className="text-sm">{s.changes.length}</Td>
                  <Td numeric>{s.netProfitChange !== null ? <Money value={s.netProfitChange} currency={c} signed /> : <span className="text-sm text-fg-muted">Needs attention</span>}</Td>
                  <Td numeric>{s.closingCashChange !== null ? <Money value={s.closingCashChange} currency={c} signed /> : '—'}</Td>
                  <Td className="text-sm text-fg-muted">{dateTime(s.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No saved assessments yet">Start from a business change above to see what it does to profit and cash.</EmptyState>
        )}
      </Card>
    </>
  );
}
