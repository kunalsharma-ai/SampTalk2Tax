'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { GroupSummary } from '@/lib/consolidation';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function ConsolidationGroupsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['consolidation-groups', orgId], queryFn: () => api<{ items: GroupSummary[] }>(`/v1/orgs/${orgId}/consolidation/groups`) });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ id: string }>(`/v1/orgs/${orgId}/consolidation/groups`, { method: 'POST', body: { name, currency: currency || null } }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: ['consolidation-groups', orgId] });
      router.push(`/orgs/${orgId}/consolidation/${g.id}`);
    },
  });
  if (!org) return null;
  const manage = can(org.role, 'org.manage');
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Group consolidation"
        description={`Report ${org.name} together with the other companies it owns: one profit and loss and balance sheet for the group, with balances between group companies removed and foreign companies translated.`}
        actions={manage && !creating ? <Button onClick={() => { setName(''); setCurrency(''); create.reset(); setCreating(true); }}>New group</Button> : null}
      />
      <ErrorAlert title="Could not load the groups" error={q.error} />
      {creating ? (
        <Card className="mb-4 p-4">
          <CardHeader title="New group" description={`${org.name} is the parent and is always in the group. You can add the other companies you own or administer next.`} />
          <form className="grid max-w-xl gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <ErrorAlert title="Could not create the group" error={create.error} />
            <Field label="Group name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind group" required maxLength={120} />}</Field>
            <Field label="Presentation currency" hint={`The currency of the group's statements. Leave empty for ${org.functionalCurrency}.`}>
              {(p) => <Input {...p} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder={org.functionalCurrency} maxLength={3} className="w-28" />}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" loading={create.isPending}>Create group</Button>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <Card className="p-4">
        <CardHeader title="Groups" />
        {q.data && !items.length ? (
          <EmptyState title="No groups yet">{manage ? 'Create a group, add the companies in it, and the consolidated statements are ready.' : 'An owner or admin can set up a group.'}</EmptyState>
        ) : null}
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Groups">
          {items.map((g) => (
            <li key={g.id} className="rounded-lg border border-line bg-surface-raised p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/orgs/${orgId}/consolidation/${g.id}`} className="font-medium text-fg hover:underline">{g.name}</Link>
                <Badge tone="accent">{g.currency}</Badge>
              </div>
              <div className="mt-2 text-sm text-fg-muted">{g.members.map((m) => `${m.name ?? 'Organisation'}${m.currency && m.currency !== g.currency ? ` (${m.currency})` : ''}`).join(' · ')}</div>
              <div className="mt-1 text-xs text-fg-faint">{g.members.length} compan{g.members.length === 1 ? 'y' : 'ies'} · {g.rules} elimination rule{g.rules === 1 ? '' : 's'} · Changed {date(g.updatedAt.slice(0, 10))}</div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
