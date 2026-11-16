'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DisputeForm, toBody } from '@/components/disputes/dispute-form';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { CHANGE_LABEL, DISPUTE_OUTCOME_LABEL, DISPUTE_OUTCOMES, DISPUTE_REASON_LABEL, type DisputeDetail, type DisputeEvent, type DisputeOutcome } from '@/lib/disputes';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';

function show(k: string, v: unknown) {
  if (v == null || v === '') return '(none)';
  if (k === 'reason') return DISPUTE_REASON_LABEL[v as keyof typeof DISPUTE_REASON_LABEL] ?? String(v);
  if (k === 'targetDate') return date(String(v));
  return String(v);
}

function EventLine({ e }: { e: DisputeEvent }) {
  const data = (e.data ?? {}) as Record<string, { from?: unknown; to?: unknown } | unknown>;
  let what: React.ReactNode;
  if (e.kind === 'RAISED') what = <>raised the dispute: {e.body}</>;
  else if (e.kind === 'NOTE') what = <>noted: {e.body}</>;
  else if (e.kind === 'RESOLVED') what = <>resolved it ({DISPUTE_OUTCOME_LABEL[(data.outcome as DisputeOutcome) ?? 'WITHDRAWN']}{data.creditNote ? `, credit note ${String(data.creditNote)}` : ''}): {e.body}</>;
  else
    what = (
      <>
        changed{' '}
        {Object.entries(data).map(([k, v], i) => {
          const c = v as { from?: unknown; to?: unknown };
          return <span key={k}>{i ? '; ' : ''}{(CHANGE_LABEL[k] ?? k).toLowerCase()} from {show(k, c.from)} to {show(k, c.to)}</span>;
        })}
      </>
    );
  return (
    <li className="border-b border-line px-5 py-3 text-sm last:border-0">
      <span className="font-medium">{e.by}</span> {what}
      <span className="block text-xs text-fg-muted">{dateTime(e.at)}</span>
    </li>
  );
}

export default function DisputePage() {
  const { org, orgId } = useOrg();
  const { disputeId } = useParams<{ disputeId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/sales/disputes/${disputeId}`;
  const key = ['disputes', orgId, 'one', disputeId];
  const q = useQuery({ queryKey: key, queryFn: () => api<DisputeDetail>(base) });
  const [editing, setEditing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<DisputeOutcome>('CREDIT_NOTE');
  const [creditNoteId, setCreditNoteId] = useState('');
  const [resolution, setResolution] = useState('');
  const done = async (d: DisputeDetail) => {
    qc.setQueryData(key, d);
    for (const k of ['disputes', 'document']) await qc.invalidateQueries({ queryKey: [k, orgId], predicate: (x) => x.queryKey[2] !== 'one' || x.queryKey[0] !== 'disputes' });
  };
  const update = useMutation({ mutationFn: (body: ReturnType<typeof toBody>) => api<DisputeDetail>(base, { method: 'PUT', body }), onSuccess: async (d) => { await done(d); setEditing(false); } });
  const addNote = useMutation({ mutationFn: () => api<DisputeDetail>(`${base}/notes`, { method: 'POST', body: { body: note } }), onSuccess: async (d) => { await done(d); setNote(''); } });
  const resolve = useMutation({
    mutationFn: () => api<DisputeDetail>(`${base}/resolve`, { method: 'POST', body: { outcome, creditNoteId: outcome === 'CREDIT_NOTE' ? creditNoteId || null : null, note: resolution } }),
    onSuccess: async (d) => { await done(d); setResolving(false); },
  });

  if (!org) return null;
  if (q.error) return <Alert title="Dispute not found">{(q.error as Error).message}</Alert>;
  const d = q.data;
  if (!d) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = d.invoice.currency;
  return (
    <>
      <PageHeader
        title={`Dispute ${d.ref}`}
        description={<>On <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${d.invoice.id}`}>invoice {d.invoice.number}</Link> for {d.customer.name}</>}
        actions={
          d.can.manage ? (
            <>
              <Button variant="secondary" onClick={() => { update.reset(); setEditing(true); }}>Change…</Button>
              <Button onClick={() => { resolve.reset(); setCreditNoteId(d.creditNotes[0]?.id ?? ''); setOutcome(d.creditNotes.length ? 'CREDIT_NOTE' : 'CUSTOMER_PAYS'); setResolution(''); setResolving(true); }}>Resolve…</Button>
            </>
          ) : null
        }
      />
      {d.status === 'RESOLVED' ? (
        <Alert tone="positive" title={`Resolved on ${date(d.resolvedOn!)}: ${DISPUTE_OUTCOME_LABEL[d.outcome!]}`}>
          {d.resolutionNote} ({d.resolvedBy}{d.creditNote ? <>, <Link className="underline" href={`/orgs/${orgId}/sales/invoices/${d.creditNote.id}`}>credit note {d.creditNote.number}</Link></> : null})
        </Alert>
      ) : (
        <Alert tone="warning" title="Open">The invoice is left out of payment reminders and overdue-invoice workflows until this dispute is resolved. It still counts in receivables and the ageing.</Alert>
      )}
      <div className="my-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">In dispute</p>
          <p className="mt-2 text-sm"><Money value={d.amount} currency={c} /> <span className="text-fg-muted">of <Money value={d.invoice.due} currency={c} /> still due</span></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Reason</p>
          <p className="mt-2 text-sm">{DISPUTE_REASON_LABEL[d.reason]}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Owner</p>
          <p className="mt-2 text-sm">{d.owner?.name ?? 'No one yet'}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Settle by</p>
          <p className="mt-2 text-sm">{d.targetDate ? date(d.targetDate) : '—'}{d.pastTarget ? <Badge tone="negative" className="ml-2">Past</Badge> : null}<span className="block text-xs text-fg-muted">Raised {date(d.openedOn)} by {d.openedBy}, {d.days} {d.days === 1 ? 'day' : 'days'}{d.status === 'OPEN' ? ' ago' : ' to settle'}</span></p>
        </Card>
      </div>
      <Card>
        <CardHeader title="What the customer disputes" />
        <p className="whitespace-pre-wrap px-5 py-4 text-sm">{d.description}</p>
      </Card>
      <Card className="mt-6">
        <CardHeader title="Dispute history" description="Every step, oldest first. It cannot be edited." />
        <ul aria-label="Dispute history">{d.events.map((e) => <EventLine key={e.id} e={e} />)}</ul>
        {d.can.manage ? (
          <form className="flex flex-col gap-2 border-t border-line px-5 py-4" onSubmit={(e) => { e.preventDefault(); addNote.mutate(); }}>
            <Textarea aria-label="Note" rows={2} maxLength={2000} value={note} placeholder="A call, an email, what was agreed" onChange={(e) => setNote(e.target.value)} />
            <ErrorAlert title="The note was not added" error={addNote.error} />
            <div className="flex justify-end"><Button type="submit" variant="secondary" loading={addNote.isPending} disabled={!note.trim()}>Add note</Button></div>
          </form>
        ) : null}
      </Card>

      <Dialog open={editing} onOpenChange={setEditing} title={`Change ${d.ref}`} description="Each change is kept in the history.">
        {editing ? (
          <DisputeForm
            initial={{ amount: d.amount, reason: d.reason, description: d.description, ownerId: d.owner?.id ?? '', targetDate: d.targetDate ?? '' }}
            members={d.members}
            today={d.targetDate && d.targetDate < d.openedOn ? d.targetDate : d.openedOn}
            maxAmount={d.invoice.due}
            currency={c}
            submitLabel="Save changes"
            pending={update.isPending}
            error={update.error}
            onSubmit={(f) => update.mutate(toBody(f))}
          />
        ) : null}
      </Dialog>

      <Dialog open={resolving} onOpenChange={setResolving} title={`Resolve ${d.ref}`} description="How the dispute was settled. A resolved dispute cannot be reopened; raise a new one if the customer queries the invoice again.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
          <label className={label}>
            Outcome
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value as DisputeOutcome)}>
              {DISPUTE_OUTCOMES.map((o) => <option key={o} value={o}>{DISPUTE_OUTCOME_LABEL[o]}</option>)}
            </Select>
          </label>
          {outcome === 'CREDIT_NOTE' ? (
            <label className={label}>
              Credit note
              {d.creditNotes.length ? (
                <Select value={creditNoteId} onChange={(e) => setCreditNoteId(e.target.value)}>
                  {d.creditNotes.map((n) => <option key={n.id} value={n.id}>{n.number} · {date(n.issueDate)} · {n.total} {n.currency}</option>)}
                </Select>
              ) : (
                <span className="normal-case tracking-normal text-warning">
                  {d.customer.name} has no posted credit note yet. <Link className="underline" href={`/orgs/${orgId}/sales/invoices/new?kind=CREDIT_NOTE&contactId=${d.customer.id}`}>Raise one</Link>, post it, then come back.
                </span>
              )}
            </label>
          ) : null}
          {outcome === 'WRITTEN_OFF' ? <p className="text-sm text-fg-muted">Record the write-off itself on <Link className="text-accent underline" href={`/orgs/${orgId}/sales/bad-debts?writeOff=${d.invoice.id}`}>Bad debts</Link>; this only closes the dispute.</p> : null}
          <label className={label}>
            How it was settled
            <Textarea rows={3} maxLength={1000} value={resolution} placeholder="e.g. Agreed the rate of 750 a unit" onChange={(e) => setResolution(e.target.value)} />
          </label>
          <ErrorAlert title="The dispute was not resolved" error={resolve.error} />
          <div className="flex justify-end"><Button type="submit" loading={resolve.isPending} disabled={!resolution.trim() || (outcome === 'CREDIT_NOTE' && !creditNoteId)}>Resolve dispute</Button></div>
        </form>
      </Dialog>
    </>
  );
}
