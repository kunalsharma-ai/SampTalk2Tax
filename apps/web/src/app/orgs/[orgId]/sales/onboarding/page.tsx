'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { ONBOARDING_STATUS, type OnboardingList, type OnboardingSettings, type OnboardingStatus } from '@/lib/onboarding';

type Item = { id: string | null; label: string; needsFile: boolean };

/** The organisation's checklist and whether new customers must be onboarded (owners and admins change it). */
function SettingsCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['onboarding-settings', orgId], queryFn: () => api<OnboardingSettings>(`/v1/orgs/${orgId}/sales/onboarding-settings`) });
  const [required, setRequired] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    if (q.data) {
      setRequired(q.data.required);
      setItems(q.data.requirements.map((r) => ({ ...r })));
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<OnboardingSettings>(`/v1/orgs/${orgId}/sales/onboarding-settings`, { method: 'PUT', body: { required, requirements: items.map((i) => ({ id: i.id, label: i.label, needsFile: i.needsFile })) } }),
    onSuccess: async (r) => {
      qc.setQueryData(['onboarding-settings', orgId], r);
      await qc.invalidateQueries({ queryKey: ['onboardings', orgId] });
    },
  });
  const d = q.data;
  if (!d) return <ErrorAlert title="Could not load the checklist" error={q.error} />;
  const edit = d.can.setUp;
  const upd = (i: number, v: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...v } : x)));
  return (
    <Card role="region" aria-label="Onboarding checklist">
      <CardHeader title="Onboarding checklist" description="What every new customer goes through besides their email, billing address, tax number and credit terms, which are read from the customer. Changes apply to onboardings started from now on." />
      <form className="space-y-3 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={required} disabled={!edit} onChange={(e) => setRequired(e.target.checked)} /> Onboard every new customer before invoicing them
        </label>
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={it.id ?? `new-${i}`} className="flex flex-wrap items-center gap-3">
              <Input aria-label={`Checklist item ${i + 1}`} className="min-w-64 flex-1" value={it.label} disabled={!edit} onChange={(e) => upd(i, { label: e.target.value })} />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={it.needsFile} disabled={!edit} onChange={(e) => upd(i, { needsFile: e.target.checked })} /> File needed</label>
              {edit ? <Button type="button" size="sm" variant="ghost" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>Remove</Button> : null}
            </li>
          ))}
        </ul>
        {edit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setItems((xs) => [...xs, { id: null, label: '', needsFile: false }])}>Add item</Button>
            <Button type="submit" loading={save.isPending}>Save checklist</Button>
            {save.isSuccess ? <span role="status" className="text-sm text-positive">Saved</span> : null}
          </div>
        ) : <p className="text-xs text-fg-muted">Owners and admins change the checklist.</p>}
        <ErrorAlert title="Not saved" error={save.error} />
      </form>
    </Card>
  );
}

/** Sales → Customer onboarding: every onboarding with where it stands, and the checklist. */
export default function OnboardingPage() {
  const { org, orgId } = useOrg();
  const [status, setStatus] = useState<OnboardingStatus | ''>('');
  const q = useQuery({ queryKey: ['onboardings', orgId, status], queryFn: () => api<OnboardingList>(`/v1/orgs/${orgId}/sales/onboardings${status ? `?status=${status}` : ''}`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Customer onboarding"
        description="New customers' details, documents and credit terms, collected and approved before they are invoiced. Open a customer to work through their checklist."
        actions={d ? <Badge tone={d.required ? 'positive' : 'neutral'}>{d.required ? 'Required for new customers' : 'Not required'}</Badge> : null}
      />
      <ErrorAlert title="Could not load onboardings" error={q.error} />
      {d ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="In progress" value={String(d.counts.OPEN)} tone="accent" />
          <Stat label="Waiting for approval" value={String(d.counts.SUBMITTED)} tone="warning" />
          <Stat label="Approved" value={String(d.counts.APPROVED)} tone="positive" />
          <Stat label="Rejected" value={String(d.counts.REJECTED)} tone="negative" />
        </div>
      ) : null}
      <Card className="mb-6">
        <CardHeader
          title="Onboardings"
          description="Every customer onboarding, newest first, with how much of the checklist is done, the proposed credit terms and its status."
          actions={
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as OnboardingStatus | '')}>
              <option value="">All</option>
              {(Object.keys(ONBOARDING_STATUS) as OnboardingStatus[]).map((s) => <option key={s} value={s}>{ONBOARDING_STATUS[s].label}</option>)}
            </Select>
          }
        />
        {d && !d.onboardings.length ? (
          <EmptyState title="No customer onboardings">Turn on onboarding for new customers below, or start one from a customer&apos;s page.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Customer</Th><Th>Status</Th><Th numeric>Done</Th><Th numeric>Credit limit</Th><Th numeric>Terms</Th><Th>Started</Th><Th>Submitted</Th></tr></thead>
            <tbody>
              {(d?.onboardings ?? []).map((o) => (
                <Tr key={o.id}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${o.contact.id}`}>{o.contact.name}</Link></Td>
                  <Td><Badge tone={ONBOARDING_STATUS[o.status].tone}>{ONBOARDING_STATUS[o.status].label}</Badge></Td>
                  <Td numeric className="num">{o.progress}%</Td>
                  <Td numeric>{o.creditLimit !== null ? <Money value={o.creditLimit} currency={c} /> : '—'}</Td>
                  <Td numeric className="num">{o.paymentTermsDays !== null ? `${o.paymentTermsDays} days` : '—'}</Td>
                  <Td className="text-fg-muted">{date(o.createdAt.slice(0, 10))}</Td>
                  <Td className="text-fg-muted">{o.submittedAt ? date(o.submittedAt.slice(0, 10)) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <SettingsCard orgId={orgId} />
    </>
  );
}
