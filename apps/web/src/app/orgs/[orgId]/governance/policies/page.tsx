'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { STATUS, type PolicyView } from '@/lib/policies';
import { can } from '@/lib/types';

/** The policy studio: financial policies in words, with the tested rules that enforce them. */
export default function PoliciesPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['policies', orgId], queryFn: () => api<{ items: PolicyView[] }>(`/v1/orgs/${orgId}/policies`), enabled: !!org });
  if (!org) return null;
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Policy studio"
        description="Write a financial policy in plain words, turn it into rules (by hand or drafted by AI), test the rules on made-up cases and on the last 90 days of real events, and have someone else approve it. Approved rules run as automations; every version is kept."
        actions={can(org.role, 'policies.manage') ? <Link className="rounded-[var(--t2t-radius-md)] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${orgId}/governance/policies/new`}>New policy</Link> : null}
      />
      <ErrorAlert title="Could not load the policies" error={q.error} />
      <Card>
        {items.length ? (
          <Table aria-label="Policies">
            <thead>
              <tr>
                <Th>Policy</Th>
                <Th>Status</Th>
                <Th>Rules</Th>
                <Th>Tests</Th>
                <Th>Version</Th>
                <Th>Last change</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/governance/policies/${p.id}`}>
                      {p.number} · {p.name}
                    </Link>
                    <p className="max-w-xl truncate text-xs text-fg-muted">{p.statement}</p>
                  </Td>
                  <Td><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge></Td>
                  <Td>{p.rules.length}</Td>
                  <Td>{p.tests.length ? <Badge tone={p.testsPassing ? 'positive' : 'negative'}>{p.testsPassing ? `${p.tests.length} pass` : `${p.testResults.filter((t) => !t.passed).length} failing`}</Badge> : <span className="text-xs text-fg-muted">None</span>}</Td>
                  <Td>
                    v{p.version}
                    {p.activeVersion && p.activeVersion !== p.version ? <p className="text-xs text-fg-muted">v{p.activeVersion} running</p> : null}
                  </Td>
                  <Td className="text-xs text-fg-muted">{p.people[p.updatedById] ?? 'Former member'}, {dateTime(p.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? (
          <EmptyState title="No policies yet">Start with a rule you already follow, such as “bills over ₹5 lakh need an approver’s review within two days”.</EmptyState>
        ) : (
          <p className="p-5 text-sm text-fg-muted">Loading…</p>
        )}
      </Card>
    </>
  );
}
