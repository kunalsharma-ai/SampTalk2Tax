'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface DemoSummary {
  organisation: { id: string; name: string };
  profile: { key: string; title: string; summary: string; countryCode: string; currency: string } | null;
  status: 'BUILDING' | 'READY' | 'FAILED';
  failure: string | null;
  counts: Record<string, number>;
  createdAt: string;
  finishedAt: string | null;
  synthetic: string;
  headline: string | null;
  recommendations: { text: string; why: string; path: string | null; priority: 'HIGH' | 'MEDIUM' }[] | null;
}

/** What each count is, and where to see the records. */
const KINDS: { key: string; label: string; path: string }[] = [
  { key: 'customers', label: 'Customers', path: '/sales/customers' },
  { key: 'vendors', label: 'Vendors', path: '/purchases/vendors' },
  { key: 'invoices', label: 'Invoices', path: '/sales/invoices' },
  { key: 'receipts', label: 'Customer payments', path: '/sales/receipts' },
  { key: 'bills', label: 'Bills', path: '/purchases/bills' },
  { key: 'payments', label: 'Vendor payments', path: '/purchases/payments' },
  { key: 'journals', label: 'Journal entries', path: '/journals' },
  { key: 'projects', label: 'Projects', path: '/dimensions' },
  { key: 'departments', label: 'Departments', path: '/dimensions' },
  { key: 'employees', label: 'Employees', path: '/payroll/employees' },
  { key: 'payRuns', label: 'Pay runs', path: '/payroll/runs' },
  { key: 'bankLines', label: 'Bank statement lines', path: '/banking' },
  { key: 'bankMatched', label: 'Bank lines matched to the books', path: '/banking' },
  { key: 'taxRates', label: 'Tax rates', path: '/settings/tax-rates' },
  { key: 'taxRegistrations', label: 'Tax registrations', path: '/tax/vat-return' },
  { key: 'filings', label: 'Returns marked filed', path: '/tax/compliance' },
  { key: 'budgets', label: 'Budgets', path: '/planning/budgets' },
  { key: 'kpiTargets', label: 'KPI targets', path: '/reports/kpis' },
  { key: 'alerts', label: 'Alerts raised by the checks', path: '/alerts' },
];

const REPORTS: [string, string][] = [
  ['Income statement', '/reports/income-statement'],
  ['Balance sheet', '/reports/balance-sheet'],
  ['Cash flow statement', '/reports/cash-flow-statement'],
  ['Trial balance', '/reports/trial-balance'],
  ['Receivables ageing', '/sales/ageing'],
  ['Budget vs actual', '/planning/budget-vs-actual'],
];

/**
 * Demonstration organisation (DEMO-001 to DEMO-021): which made-up company this is, what was
 * posted, the reports to look at and the CFO's recommendations from its books. Labelled synthetic.
 */
export default function DemoSummaryPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['demo-organisation', orgId], queryFn: () => api<DemoSummary>(`/v1/orgs/${orgId}/demo-organisation`), retry: false });
  if (!org) return null;
  const d = q.data;
  const kinds = KINDS.filter((k) => d && d.counts[k.key] !== undefined);
  // Payroll lives only in Indian demonstrations; elsewhere staff are paid by salary journals.
  const staffNote = d?.profile && d.profile.countryCode !== 'IN' ? 'Staff are paid by monthly salary journals by department; payroll with payslips is for organisations in India.' : null;
  return (
    <>
      <PageHeader
        title="Demonstration organisation"
        description="A made-up company with six months of synthetic books, posted through the same services as your own work. Look around, change anything, and see what Talk2Tax makes of it."
      />
      {q.error ? <ErrorAlert title="Could not load the demonstration" error={q.error} /> : null}
      {d ? (
        <div className="grid gap-6">
          <Alert tone="warning" title="Synthetic demonstration data">
            {d.synthetic}
          </Alert>
          {d.status === 'FAILED' ? <Alert title="The demonstration stopped part-way">{`What was posted before it stopped is kept: ${d.failure ?? 'no reason was recorded'}.`}</Alert> : null}
          <Card className="p-5">
            <p className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              {d.profile?.title ?? 'Demonstration'}{' '}
              <Badge tone={d.status === 'READY' ? 'positive' : d.status === 'FAILED' ? 'negative' : 'warning'}>{d.status === 'READY' ? 'Ready' : d.status === 'FAILED' ? 'Stopped' : 'Building'}</Badge>
            </p>
            <p className="mt-1 text-sm text-fg-muted">{d.profile?.summary}</p>
            <p className="mt-2 text-xs text-fg-faint">Created {dateTime(d.createdAt)}</p>
          </Card>
          <Card role="region" aria-label="What the demo holds">
            <CardHeader title="What the demo holds" description="Everything posted to build this organisation, with where to find it." />
            <Table aria-label="Records made for the demonstration">
              <thead>
                <Tr>
                  <Th>Records</Th>
                  <Th className="text-right">Made</Th>
                </Tr>
              </thead>
              <tbody>
                {kinds.map((k) => (
                  <Tr key={k.key}>
                    <Td>
                      <Link className="hover:text-accent" href={`/orgs/${orgId}${k.key === 'taxRegistrations' && d.profile?.countryCode === 'IN' ? '/settings/gst' : k.path}`}>
                        {k.label}
                      </Link>
                      {k.key === 'employees' && staffNote ? <div className="text-xs text-fg-faint">{staffNote}</div> : null}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">{d.counts[k.key]}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card role="region" aria-label="Reports to start with">
            <CardHeader title="Reports to start with" description="The books are ordinary books, so every report reads them." />
            <ul className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {REPORTS.map(([label, path]) => (
                <li key={path}>
                  <Link className="text-accent hover:underline" href={`/orgs/${orgId}${path}`}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card role="region" aria-label="What the books suggest">
            <CardHeader title="What the books suggest" description="The CFO assessment's recommendations, worked out from these synthetic books like any others." />
            <div className="px-5 py-4 text-sm">
              {d.headline ? <p className="mb-3 text-fg">{d.headline}</p> : null}
              {d.recommendations === null ? (
                <p className="text-fg-muted">Recommendations need reports.read, and a finished demonstration.</p>
              ) : d.recommendations.length === 0 ? (
                <p className="text-fg-muted">Nothing needs action at the moment.</p>
              ) : (
                <ol className="grid gap-3">
                  {d.recommendations.map((r) => (
                    <li key={r.text} className="rounded-[var(--t2t-radius-md)] border border-line px-4 py-3">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {r.text} <Badge tone={r.priority === 'HIGH' ? 'negative' : 'warning'}>{r.priority === 'HIGH' ? 'High' : 'Medium'}</Badge>
                      </p>
                      <p className="mt-1 text-fg-muted">{r.why}</p>
                      {r.path ? (
                        <Link className="mt-1 inline-block text-accent hover:underline" href={`/orgs/${orgId}${r.path}`}>
                          Open
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-3">
                <Link className="text-accent hover:underline" href={`/orgs/${orgId}/cfo`}>
                  The full CFO assessment
                </Link>
              </p>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
