'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEAD_SOURCE_LABEL } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { LeadStatusBadge, StageBadge, Timeline } from '@/components/crm/bits';
import { LeadDialog } from '@/components/crm/lead-dialog';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { LeadDetail, LeadStatus } from '@/lib/crm';
import { dateTime, today } from '@/lib/format';
import { useContacts, useOrg } from '@/lib/org';

const plusDays = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export default function LeadPage() {
  const { org, orgId } = useOrg();
  const { leadId } = useParams<{ leadId: string }>();
  const qc = useQueryClient();
  const key = ['crm-lead', orgId, leadId];
  const lead = useQuery({ queryKey: key, queryFn: () => api<LeadDetail>(`/v1/orgs/${orgId}/crm/leads/${leadId}`) });
  const [editing, setEditing] = useState(false);
  const [disqualify, setDisqualify] = useState(false);
  const [reason, setReason] = useState('');
  const [converting, setConverting] = useState(false);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ['crm-leads', orgId] });
  };
  const move = useMutation({
    mutationFn: (b: { status: LeadStatus; reason?: string }) => api<LeadDetail>(`/v1/orgs/${orgId}/crm/leads/${leadId}/status`, { method: 'POST', body: b }),
    onSuccess: async () => {
      setDisqualify(false);
      setReason('');
      await refresh();
    },
  });
  if (!org) return null;
  if (lead.error) return <ErrorAlert title="Could not load the lead" error={lead.error} />;
  const l = lead.data;
  if (!l) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = org.functionalCurrency;
  const m = l.can.manage && l.status !== 'CONVERTED';
  return (
    <>
      <PageHeader
        title={`${l.reference} ${l.name}`}
        description={[l.company, l.email, l.phone, `from ${LEAD_SOURCE_LABEL[l.source].toLowerCase()}`].filter(Boolean).join(' · ')}
        actions={
          m ? (
            <>
              <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
              {l.status === 'NEW' ? <Button variant="secondary" loading={move.isPending} onClick={() => move.mutate({ status: 'CONTACTED' })}>Mark contacted</Button> : null}
              {l.status === 'DISQUALIFIED' ? <Button variant="secondary" loading={move.isPending} onClick={() => move.mutate({ status: 'CONTACTED' })}>Reopen</Button> : null}
              {l.status === 'NEW' || l.status === 'CONTACTED' ? <Button variant="secondary" loading={move.isPending} onClick={() => move.mutate({ status: 'QUALIFIED' })}>Qualify</Button> : null}
              {l.status !== 'DISQUALIFIED' ? <Button variant="danger" onClick={() => setDisqualify(true)}>Disqualify</Button> : null}
              {l.status === 'QUALIFIED' ? <Button onClick={() => setConverting(true)}>Convert to customer</Button> : null}
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not change the status" error={move.error} />
      {l.duplicates.contacts.length || l.duplicates.leads.length ? (
        <div className="mb-4">
          <Alert tone="warning" title="Possible duplicate">
            Same email as{' '}
            {[
              ...l.duplicates.contacts.map((c) => <Link key={c.id} className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${c.id}`}>{c.name}</Link>),
              ...l.duplicates.leads.map((d) => <Link key={d.id} className="text-accent hover:underline" href={`/orgs/${orgId}/sales/leads/${d.id}`}>{d.reference} {d.name}</Link>),
            ].flatMap((x, i) => (i ? [<span key={`s${i}`}>, </span>, x] : [x]))}
            . When converting, attach it to the existing customer instead of creating another.
          </Alert>
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Lead" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">Status</dt><dd><LeadStatusBadge status={l.status} /></dd>
            {l.disqualifiedReason ? <><dt className="text-fg-muted">Why</dt><dd>{l.disqualifiedReason}</dd></> : null}
            <dt className="text-fg-muted">Owner</dt><dd>{l.owner?.name ?? 'Nobody yet'}</dd>
            <dt className="text-fg-muted">Estimated value</dt><dd>{l.estimatedValue ? <Money value={l.estimatedValue} currency={cur} /> : '—'}</dd>
            <dt className="text-fg-muted">Added</dt><dd>{dateTime(l.createdAt)}</dd>
            {l.convertedContact ? <><dt className="text-fg-muted">Customer</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${l.convertedContact.id}`}>{l.convertedContact.name}</Link></dd></> : null}
            {l.convertedDeal ? <><dt className="text-fg-muted">Deal</dt><dd className="flex flex-wrap items-center gap-2"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${l.convertedDeal.id}`}>{l.convertedDeal.reference} {l.convertedDeal.name}</Link><StageBadge stage={l.convertedDeal.stage} /></dd></> : null}
            {l.notes ? <><dt className="text-fg-muted">Notes</dt><dd className="whitespace-pre-wrap">{l.notes}</dd></> : null}
          </dl>
        </Card>
        <div className="xl:col-span-2">
          <Timeline orgId={orgId} target={{ leadId: l.id }} activities={l.activities} canLog={l.can.manage} currency={cur} queryKey={key} />
        </div>
      </div>
      <LeadDialog orgId={orgId} open={editing} onOpenChange={setEditing} lead={l} currency={cur} />
      <Dialog open={disqualify} onOpenChange={setDisqualify} title={`Disqualify ${l.reference}`} description="The lead stays on record with the reason, and can be reopened later.">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            move.mutate({ status: 'DISQUALIFIED', reason });
          }}
        >
          <Field label="Reason">{(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="No budget this year" />}</Field>
          <ErrorAlert title="Could not disqualify" error={move.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={move.isPending} disabled={!reason.trim()}>Disqualify</Button></div>
        </form>
      </Dialog>
      <ConvertDialog orgId={orgId} lead={l} open={converting} onOpenChange={setConverting} onDone={refresh} currency={cur} />
    </>
  );
}

function ConvertDialog({ orgId, lead, open, onOpenChange, onDone, currency }: { orgId: string; lead: LeadDetail; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => Promise<void>; currency: string }) {
  const contacts = useContacts(undefined);
  const suggested = lead.duplicates.contacts[0]?.id ?? '';
  const [contactId, setContactId] = useState<string>(suggested);
  const [withDeal, setWithDeal] = useState(true);
  const [deal, setDeal] = useState({ name: `${lead.company ?? lead.name}: first order`, amount: lead.estimatedValue ?? '', expectedCloseDate: plusDays(30) });
  const convert = useMutation({
    mutationFn: () => api<LeadDetail>(`/v1/orgs/${orgId}/crm/leads/${lead.id}/convert`, { method: 'POST', body: { contactId: contactId || null, deal: withDeal ? { ...deal, amount: deal.amount.replace(/,/g, '') } : null } }),
    onSuccess: async () => {
      onOpenChange(false);
      await onDone();
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Convert ${lead.reference} to a customer`} description="The lead closes for good. Its customer can then be invoiced, and its deal moves through the pipeline.">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          convert.mutate();
        }}
      >
        <Field label="Customer" hint={contactId ? 'An existing contact; a vendor becomes a customer too.' : `A new customer named “${lead.company ?? lead.name}” is created with the lead's email and phone.`}>
          {(p) => (
            <Select {...p} value={contactId} onChange={(e) => setContactId(e.target.value)}>
              {lead.can.manageContacts ? <option value="">Create a new customer</option> : <option value="" disabled>Choose an existing contact</option>}
              {contacts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withDeal} onChange={(e) => setWithDeal(e.target.checked)} /> Open a deal at the qualification stage</label>
        {withDeal ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Deal name">{(p) => <Input {...p} value={deal.name} onChange={(e) => setDeal((d) => ({ ...d, name: e.target.value }))} />}</Field></div>
            <Field label={`Amount (${currency})`}>{(p) => <Input {...p} inputMode="decimal" className="num" value={deal.amount} onChange={(e) => setDeal((d) => ({ ...d, amount: e.target.value }))} />}</Field>
            <Field label="Expected to close">{(p) => <Input {...p} type="date" value={deal.expectedCloseDate} onChange={(e) => setDeal((d) => ({ ...d, expectedCloseDate: e.target.value }))} />}</Field>
          </div>
        ) : null}
        <ErrorAlert title="Could not convert the lead" error={convert.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={convert.isPending}>Convert</Button>
        </div>
      </form>
    </Dialog>
  );
}
