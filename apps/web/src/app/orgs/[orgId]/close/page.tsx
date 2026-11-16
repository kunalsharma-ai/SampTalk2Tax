'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { CLOSE_STATUS, type ClosePeriodRow } from '@/lib/close';
import { dateTime } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function CloseListPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['close-list', orgId], queryFn: () => api<{ periods: ClosePeriodRow[] }>(`/v1/orgs/${orgId}/close`) });
  if (!org) return null;
  const rows = q.data?.periods ?? [];
  return (
    <>
      <PageHeader
        title="Month-end close"
        description="Close each month in order: work through the checklist worked out from the books, have the AI review the month and propose adjusting entries for a person to post or reject, then an owner or admin closes it. Closing locks the month and records a certification of what was true; reopening needs a reason."
      />
      <ErrorAlert title="Could not load months" error={q.error} />
      {q.data ? (
        rows.length ? (
          <Card className="overflow-x-auto">
            <Table aria-label="Months">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th>Dates</Th>
                  <Th>Close</Th>
                  <Th>Closed by</Th>
                  <Th>Period</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/close/${p.id}`}>{p.name}</Link>
                      {p.current ? <span className="ml-2 text-xs text-fg-faint">this month</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-sm text-fg-muted">{date(p.startDate)} to {date(p.endDate)}</Td>
                    <Td><Badge tone={CLOSE_STATUS[p.closeStatus].tone}>{CLOSE_STATUS[p.closeStatus].label}</Badge></Td>
                    <Td className="text-sm">{p.closedBy ? `${p.closedBy}, ${dateTime(p.closedAt!)}` : '—'}</Td>
                    <Td className="text-sm text-fg-muted">{p.periodStatus === 'OPEN' ? 'Open' : p.periodStatus === 'LOCKED' ? 'Locked' : 'Closed for good'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : (
          <Card>
            <EmptyState title="No months yet">Months appear here once a fiscal year that has started is set up.</EmptyState>
          </Card>
        )
      ) : null}
    </>
  );
}
