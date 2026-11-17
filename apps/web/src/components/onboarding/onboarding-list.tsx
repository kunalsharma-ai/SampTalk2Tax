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
import { ONBOARDING_STATUS, PARTY, type OnboardingList, type OnboardingSettings, type OnboardingStatus, type Party } from '@/lib/onboarding';

type Item = { id: string | null; label: string; needsFile: boolean };

const WORDS: Record<Party, { who: string; whoPl: string; readFrom: string; required: string; gate: string; description: string; terms: string }> = {
  CUSTOMER: {
    who: 'customer', whoPl: 'customers',
    readFrom: 'their email, billing address, tax number and credit terms',
    required: 'Onboard every new customer before invoicing them',
    gate: 'Required for new customers',
    description: "New customers' details, documents and credit terms, collected and approved before they are invoiced. Open a customer to work through their checklist.",
    terms: 'the proposed credit terms',
  },
  VENDOR: {
    who: 'vendor', whoPl: 'vendors',
    readFrom: 'their email, address, tax number, verified bank details and payment terms',
    required: 'Onboard every new vendor before posting their bills or paying them',
    gate: 'Required for new vendors',
    description: "New vendors' tax details, verified bank account, documents and payment terms, collected and approved before their bills are posted or they are paid. Open a vendor to work through their checklist.",
    terms: 'the proposed payment terms',
  },
};

/** The organisation's checklist and whether new customers or vendors must be onboarded (owners and admins change it). */
function SettingsCard({ orgId, party }: { orgId: string; party: Party }) {
  const P = PARTY[party];
  const W = WORDS[party];
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['onboarding-settings', orgId, party], queryFn: () => api<OnboardingSettings>(`/v1/orgs/${orgId}/${P.api}/onboarding-settings`) });
  const [required, setRequired] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    if (q.data) {
      setRequired(q.data.required);
      setItems(q.data.requirements.map((r) => ({ ...r })));
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<OnboardingSettings>(`/v1/orgs/${orgId}/${P.api}/onboarding-settings`, { method: 'PUT', body: { required, requirements: items.map((i) => ({ id: i.id, label: i.label, needsFile: i.needsFile })) } }),
    onSuccess: async (r) => {
      qc.setQueryData(['onboarding-settings', orgId, party], r);
      await qc.invalidateQueries({ queryKey: ['onboardings', orgId, party] });
    },
  });
  const d = q.data;
  if (!d) return <ErrorAlert title="Could not load the checklist" error={q.error} />;
  const edit = d.can.setUp;
  const upd = (i: number, v: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...v } : x)));
  return (
    <Card role="region" aria-label="Onboarding checklist">
      <CardHeader title="Onboarding checklist" description={`What every new ${W.who} goes through besides ${W.readFrom}, which are read from the ${W.who}. Changes apply to onboardings started from now on.`} />
      <form className="space-y-3 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={required} disabled={!edit} onChange={(e) => setRequired(e.target.checked)} /> {W.required}
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

/** Customer (Sales) or vendor (Purchases) onboarding: every onboarding with where it stands, and the checklist. */
export function OnboardingListPage({ party }: { party: Party }) {
  const P = PARTY[party];
  const W = WORDS[party];
  const { org, orgId } = useOrg();
  const [status, setStatus] = useState<OnboardingStatus | ''>('');
  const q = useQuery({ queryKey: ['onboardings', orgId, party, status], queryFn: () => api<OnboardingList>(`/v1/orgs/${orgId}/${P.api}/onboardings${status ? `?status=${status}` : ''}`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title={P.title}
        description={W.description}
        actions={d ? <Badge tone={d.required ? 'positive' : 'neutral'}>{d.required ? W.gate : 'Not required'}</Badge> : null}
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
          description={`Every ${W.who} onboarding, newest first, with how much of the checklist is done, ${W.terms} and its status.`}
          actions={
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as OnboardingStatus | '')}>
              <option value="">All</option>
              {(Object.keys(ONBOARDING_STATUS) as OnboardingStatus[]).map((s) => <option key={s} value={s}>{ONBOARDING_STATUS[s].label}</option>)}
            </Select>
          }
        />
        {d && !d.onboardings.length ? (
          <EmptyState title={`No ${W.who} onboardings`}>{`Turn on onboarding for new ${W.whoPl} below, or start one from a ${W.who}'s page.`}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>{party === 'VENDOR' ? 'Vendor' : 'Customer'}</Th><Th>Status</Th><Th numeric>Done</Th>{party === 'CUSTOMER' ? <Th numeric>Credit limit</Th> : null}<Th numeric>Terms</Th><Th>Started</Th><Th>Submitted</Th></tr></thead>
            <tbody>
              {(d?.onboardings ?? []).map((o) => (
                <Tr key={o.id}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/${P.pagePath}/${o.contact.id}`}>{o.contact.name}</Link></Td>
                  <Td><Badge tone={ONBOARDING_STATUS[o.status].tone}>{ONBOARDING_STATUS[o.status].label}</Badge></Td>
                  <Td numeric className="num">{o.progress}%</Td>
                  {party === 'CUSTOMER' ? <Td numeric>{o.creditLimit !== null ? <Money value={o.creditLimit} currency={c} /> : '—'}</Td> : null}
                  <Td numeric className="num">{o.paymentTermsDays !== null ? `${o.paymentTermsDays} days` : '—'}</Td>
                  <Td className="text-fg-muted">{date(o.createdAt.slice(0, 10))}</Td>
                  <Td className="text-fg-muted">{o.submittedAt ? date(o.submittedAt.slice(0, 10)) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <SettingsCard orgId={orgId} party={party} />
    </>
  );
}

