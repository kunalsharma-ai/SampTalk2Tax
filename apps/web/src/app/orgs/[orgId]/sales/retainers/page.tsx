'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { RetainerTermsFields, type TermsValue } from '@/components/retainers/retainer-terms';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useContacts, useOrg } from '@/lib/org';
import { RETAINER_STATE, type RetainerDetail, type RetainerList } from '@/lib/retainers';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';

export default function RetainersPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [view, setView] = useState<'active' | 'closed' | 'all'>('active');
  const q = useQuery({ queryKey: ['retainers', orgId, view], queryFn: () => api<RetainerList>(`/v1/orgs/${orgId}/sales/retainers?view=${view}`) });
  const customers = useContacts('customer');
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState('');
  const [v, setV] = useState<TermsValue>({ name: '', amount: '', minimumBalance: '', startDate: today(), terms: '' });
  const create = useMutation({
    mutationFn: () => api<RetainerDetail>(`/v1/orgs/${orgId}/sales/retainers`, { method: 'POST', body: { contactId, name: v.name, amount: v.amount || '0', minimumBalance: v.minimumBalance || '0', startDate: v.startDate, terms: v.terms || null } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['retainers', orgId] });
      router.push(`/orgs/${orgId}/sales/retainers/${r.id}`);
    },
  });
  if (!org) return null;
  const s = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Retainers"
        description="Money a customer keeps on account with you at an agreed level. It is held as their receipts, not yet applied, and drawn down to pay their invoices. When the balance falls below the agreed minimum, a top-up is due."
        actions={s?.can.manage ? <Button onClick={() => { create.reset(); setOpen(true); }}>New retainer</Button> : null}
      />
      <ErrorAlert title="Could not load retainers" error={q.error} />
      {s ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-3">
            <Stat label="Held for customers" value={<Money value={s.totals.held} currency={c} />} tone="accent" sub="Receipts not yet applied, on active retainers" />
            <Stat label="Top-ups due" value={String(s.totals.due)} tone={s.totals.due ? 'warning' : 'positive'} sub="Retainers below their minimum" />
            <Stat label="To request" value={<Money value={s.totals.topUpDue} currency={c} />} tone={s.totals.due ? 'warning' : 'neutral'} sub="To bring them back to the agreed amount" />
          </div>
          <Card>
            <CardHeader title="Retainers" description="Newest first. Open one to record a receipt into it, pay invoices from it or close it." />
            <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-3">
              <label className={label}>
                Show
                <Select className="w-44" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
                  <option value="active">Active</option>
                  <option value="closed">Closed</option>
                  <option value="all">All</option>
                </Select>
              </label>
            </div>
            {s.retainers.length === 0 ? (
              <EmptyState title="No retainers here">Agree one with a customer with New retainer.</EmptyState>
            ) : (
              <Table aria-label="Retainers">
                <thead><tr><Th>Number</Th><Th>Customer</Th><Th>Name</Th><Th>Since</Th><Th numeric>Agreed</Th><Th numeric>Held</Th><Th numeric>Top-up due</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {s.retainers.map((r) => (
                    <Tr key={r.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/retainers/${r.id}`}>{r.reference}</Link></Td>
                      <Td>{r.contact?.name}</Td>
                      <Td>{r.name}</Td>
                      <Td>{date(r.startDate)}</Td>
                      <Td numeric><Money value={r.amount} currency={r.currency} /></Td>
                      <Td numeric><Money value={r.held} currency={r.currency} /></Td>
                      <Td numeric>{Number(r.topUpDue) > 0 ? <Money value={r.topUpDue} currency={r.currency} /> : '—'}</Td>
                      <Td><Badge tone={RETAINER_STATE[r.state].tone}>{RETAINER_STATE[r.state].label}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen} title="New retainer" description="Agree how much the customer keeps on account. Record their receipts into it afterwards.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Customer">
            {(p) => (
              <Select {...p} value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">Choose a customer</option>
                {(customers.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          <RetainerTermsFields v={v} set={setV} />
          <ErrorAlert title="Could not save the retainer" error={create.error} />
          <div className="flex justify-end"><Button type="submit" loading={create.isPending} disabled={!contactId || !v.name.trim() || !v.amount}>Save retainer</Button></div>
        </form>
      </Dialog>
    </>
  );
}
