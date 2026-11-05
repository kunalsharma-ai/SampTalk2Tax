'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { PlatformRole, ROLE_LABEL } from '@/lib/admin';

interface Overview {
  organisations: { total: number; suspended: number; demo: number; createdLast30Days: number };
  people: { total: number; disabled: number; joinedLast30Days: number; signedInLast30Days: number };
  administrators: { id: string; name: string; email: string; platformRole: PlatformRole }[];
}

export default function AdminOverviewPage() {
  const q = useQuery({ queryKey: ['admin-overview'], queryFn: () => api<Overview>('/v1/admin/overview') });
  const o = q.data;
  return (
    <>
      <PageHeader
        title="Platform overview"
        description="Organisations, people and announcements across the service. Administrators see each organisation's name, country, region, members and status, never its books: accounts, journals, documents and amounts stay with its members."
      />
      <ErrorAlert title="Could not load the overview" error={q.error} />
      {o ? (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Organisations" value={o.organisations.total} sub={`${o.organisations.createdLast30Days} new in the last 30 days · ${o.organisations.demo} demo`} />
            <Stat label="Suspended" value={o.organisations.suspended} tone={o.organisations.suspended ? 'warning' : 'neutral'} sub="Readable by members, not changeable" />
            <Stat label="People" value={o.people.total} sub={`${o.people.joinedLast30Days} joined in the last 30 days · ${o.people.disabled} disabled`} />
            <Stat label="Signed in, last 30 days" value={o.people.signedInLast30Days} tone="positive" sub="People with a session used in 30 days" />
          </div>
          <Card aria-label="Administrators">
            <CardHeader title="Administrators" description="Super admins manage organisations, people and announcements; support looks things up. Roles are changed under People." />
            <Table>
              <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th></tr></thead>
              <tbody>
                {o.administrators.map((a) => (
                  <Tr key={a.id}><Td>{a.name}</Td><Td className="text-fg-muted">{a.email}</Td><Td>{ROLE_LABEL[a.platformRole]}</Td></Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}
