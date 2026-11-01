'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { monthLabel, type ReportMonth } from '@/lib/kpis';
import { useOrg } from '@/lib/org';

export default function ManagementReportsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['management-reports', orgId], queryFn: () => api<ReportMonth[]>(`/v1/orgs/${orgId}/management-reports`) });
  if (!org) return null;
  return (
    <>
      <PageHeader
        title="Management reports"
        description="One report a month: profit and loss against the month before, the same month last year and the approved budget, cash, KPIs and top customers, with your commentary. Finalising a month freezes its figures and commentary; later postings are listed against it, not folded in."
      />
      <ErrorAlert title="Could not load" error={q.error} />
      {q.data ? (
        <Card>
          <CardHeader title="Last 24 months" />
          <Table>
            <thead>
              <tr>
                <Th>Month</Th>
                <Th>Status</Th>
                <Th>Finalised</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((m) => (
                <Tr key={m.month} aria-label={monthLabel(m.month)}>
                  <Td>
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/management/${m.month}`}>{monthLabel(m.month)}</Link>
                  </Td>
                  <Td>
                    {m.status === 'FINAL' ? <Badge tone="positive">Final</Badge> : !m.ended ? <Badge tone="warning">In progress</Badge> : m.hasCommentary ? <Badge tone="accent">Draft with commentary</Badge> : <Badge>Draft</Badge>}
                  </Td>
                  <Td className="text-fg-muted">{m.finalisedAt ? `${m.finalisedBy}, ${date(m.finalisedAt.slice(0, 10))}` : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
