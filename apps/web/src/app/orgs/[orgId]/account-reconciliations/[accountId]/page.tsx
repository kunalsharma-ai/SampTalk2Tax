'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, SectionHelpSlot, Select, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { EVENT_LABEL, KIND_LABEL, lastMonthEnd, STATE_LABEL, STATE_TONE, type ReconDetail, type ReconItem, type ReconItemKind } from '@/lib/account-reconciliations';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const blank = (): ReconItem => ({ description: '', reference: '', amount: '', kind: 'SUPPORT' });

export default function AccountReconciliationPage() {
  return (
    <Suspense>
      <Reconciliation />
    </Suspense>
  );
}

/** One balance sheet account at one date (GL-032): the items behind its balance, sign-off and review. */
function Reconciliation() {
  const { org, orgId } = useOrg();
  const { accountId } = useParams<{ accountId: string }>();
  const asOf = useSearchParams().get('asOf') || lastMonthEnd();
  const me = useMe();
  const qc = useQueryClient();
  const key = ['account-reconciliations', orgId, asOf, accountId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ReconDetail>(`/v1/orgs/${orgId}/account-reconciliations/${accountId}?asOf=${asOf}`) });
  const [items, setItems] = useState<ReconItem[]>([]);
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [reason, setReason] = useState('');
  const r = q.data;
  useEffect(() => {
    if (!r || dirty) return;
    setItems(r.items.length ? r.items.map((i) => ({ ...i, reference: i.reference ?? '' })) : [blank()]);
    setNotes(r.notes ?? '');
  }, [r, dirty]);
  const done = async (d: ReconDetail) => {
    qc.setQueryData(key, d);
    setDirty(false);
    await qc.invalidateQueries({ queryKey: ['account-reconciliations', orgId, asOf] });
  };
  const base = `/v1/orgs/${orgId}/account-reconciliations/${accountId}`;
  const save = useMutation({
    mutationFn: () => api<ReconDetail>(base, { method: 'PUT', body: { asOf, notes, items: items.filter((i) => i.description || i.amount).map((i) => ({ ...i, reference: i.reference || null })) } }),
    onSuccess: done,
  });
  const act = useMutation({
    mutationFn: (a: { path: 'prepare' | 'review' | 'reopen'; body: Record<string, unknown> }) => api<ReconDetail>(`${base}/${a.path}`, { method: 'POST', body: { asOf, ...a.body } }),
    onSuccess: async (d) => {
      setReviewNote('');
      setReason('');
      await done(d);
    },
  });
  if (!org) return null;
  const manage = can(org.role, 'close.manage');
  const editable = manage && (r?.status ?? 'DRAFT') !== 'REVIEWED';
  const set = (i: number, patch: Partial<ReconItem>) => {
    setDirty(true);
    setItems((rs) => rs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };
  const explained = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const left = r ? Number(r.ledgerBalance) - explained : 0;
  return (
    <>
      <PageHeader
        title={r ? `${r.code} ${r.name}` : 'Account reconciliation'}
        description={`Reconciled to ${date(asOf)}. List what makes up the balance; the preparer signs off when nothing is left unexplained, then someone else reviews it.`}
        actions={<Link href={`/orgs/${orgId}/account-reconciliations?asOf=${asOf}`}><Button variant="secondary">All accounts</Button></Link>}
      />
      <ErrorAlert title="Could not load the reconciliation" error={q.error as Error | null} />
      {r ? (
        <>
          {r.state === 'CHANGED' ? (
            <div className="mb-4">
              <Alert tone="negative" title="The ledger moved after sign-off">
                It was signed off at <Money value={r.savedLedgerBalance ?? '0'} currency={r.currency} /> and is now <Money value={r.ledgerBalance} currency={r.currency} />. Reopen it, explain the change and sign off again.
              </Alert>
            </div>
          ) : null}
          {r.isBank ? <p className="mb-4 text-sm text-fg-muted">This is a bank or cash account: match it line by line in <Link className="text-accent underline" href={`/orgs/${orgId}/banking/${r.accountId}/reconcile`}>bank reconciliation</Link>, and record the statement balance here as its support.</p> : null}
          <div className="mb-6 grid gap-4 sm:grid-cols-4">
            <Stat label="Ledger balance" value={<Money value={r.ledgerBalance} currency={r.currency} />} sub={r.type === 'ASSET' ? 'Debit balance' : 'Credit balance'} />
            {r.subledgerBalance !== null ? <Stat label="Subsidiary ledger" value={<Money value={r.subledgerBalance} currency={r.currency} />} sub="Open items at the date" /> : <Stat label="Explained" value={<Money value={explained.toFixed(2)} currency={r.currency} />} />}
            <Stat label="Unexplained" value={<Money value={left.toFixed(2)} currency={r.currency} />} tone={Math.abs(left) < 0.005 ? 'positive' : 'negative'} />
            <Stat label="Status" value={<Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>} sub={[r.preparedBy && `Prepared by ${r.preparedBy}`, r.reviewedBy && `reviewed by ${r.reviewedBy}`].filter(Boolean).join(', ') || undefined} />
          </div>
          <Card className="mb-4">
            <CardHeader title="What makes up the balance" help={<SectionHelpSlot title="What makes up the balance" />} description="Supporting balances come from outside the ledger (a count, a statement, a schedule). Reconciling items are timing differences, such as goods received not yet billed; enter them with a minus to reduce." />
            <div className="space-y-2 p-5">
              {r.suggestions.length && editable ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-fg-muted">From the books:</span>
                  {r.suggestions.map((s) => (
                    <Button key={s.description} size="sm" variant="secondary" onClick={() => { setDirty(true); setItems((rs) => [...rs.filter((x) => x.description || x.amount), { ...s }]); }}>
                      Add {s.description.toLowerCase()} (<Money value={s.amount} currency={r.currency} />)
                    </Button>
                  ))}
                </div>
              ) : null}
              {editable ? (
                <>
                  {items.map((it, i) => (
                    <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9rem_11rem_9rem_auto]">
                      <Input aria-label={`What item ${i + 1} is`} value={it.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Stock count at the month end" maxLength={200} />
                      <Input aria-label={`Reference for item ${i + 1}`} value={it.reference ?? ''} onChange={(e) => set(i, { reference: e.target.value })} placeholder="Reference" maxLength={100} />
                      <Select aria-label={`Kind of item ${i + 1}`} value={it.kind} onChange={(e) => set(i, { kind: e.target.value as ReconItemKind })}>
                        {(Object.keys(KIND_LABEL) as ReconItemKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </Select>
                      <Input aria-label={`Amount of item ${i + 1}`} className="num text-right" inputMode="decimal" value={it.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="0.00" />
                      <Button type="button" size="sm" variant="ghost" onClick={() => { setDirty(true); setItems((rs) => rs.filter((_, j) => j !== i)); }} aria-label={`Remove item ${i + 1}`}>Remove</Button>
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setDirty(true); setItems((rs) => [...rs, blank()]); }}>Add an item</Button>
                  <Field label="Notes">{(p) => <Textarea {...p} value={notes} onChange={(e) => { setDirty(true); setNotes(e.target.value); }} maxLength={2000} rows={2} placeholder="How the balance was checked" />}</Field>
                  <ErrorAlert title="Could not save" error={save.error as Error | null} />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => save.mutate()} disabled={save.isPending}>Save draft</Button>
                    {r.status === 'DRAFT' && !dirty ? <Button variant="secondary" disabled={act.isPending || !r.balanced} onClick={() => act.mutate({ path: 'prepare', body: {} })}>Sign off as preparer</Button> : null}
                    {r.status === 'DRAFT' && !dirty && !r.balanced ? <span className="self-center text-sm text-fg-muted">Sign-off opens once nothing is unexplained.</span> : null}
                  </div>
                </>
              ) : (
                <Table aria-label="Items">
                  <thead>
                    <tr><Th>Item</Th><Th>Reference</Th><Th>Kind</Th><Th numeric>Amount</Th></tr>
                  </thead>
                  <tbody>
                    {r.items.map((i) => (
                      <Tr key={i.id}><Td>{i.description}</Td><Td>{i.reference ?? '–'}</Td><Td>{KIND_LABEL[i.kind]}</Td><Td numeric><Money value={i.amount} currency={r.currency} /></Td></Tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {!editable && r.notes ? <p className="text-sm text-fg-muted">{r.notes}</p> : null}
            </div>
          </Card>
          {manage && (r.status === 'PREPARED' || r.status === 'REVIEWED') ? (
            <Card className="mb-4">
              <CardHeader title="Reconciliation review" help={<SectionHelpSlot title="Reconciliation review" />} description={r.status === 'PREPARED' ? 'Someone other than the preparer checks the items against their evidence and signs off.' : 'Reviewed. Reopen it to change anything, with the reason.'} />
              <div className="space-y-3 p-5">
                {r.status === 'PREPARED' ? (
                  me.data?.user.id === r.preparedById ? <p className="text-sm text-fg-muted">You prepared this, so someone else reviews it.</p> : (
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-64 flex-1"><Field label="Review note (optional)">{(p) => <Input {...p} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} maxLength={1000} placeholder="Agreed to the count sheets" />}</Field></div>
                      <Button onClick={() => act.mutate({ path: 'review', body: { note: reviewNote || null } })} disabled={act.isPending}>Mark reviewed</Button>
                    </div>
                  )
                ) : null}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-64 flex-1"><Field label="Reason to reopen">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="A late invoice was posted" />}</Field></div>
                  <Button variant="secondary" onClick={() => act.mutate({ path: 'reopen', body: { reason } })} disabled={act.isPending || reason.trim().length < 3}>Reopen</Button>
                </div>
              </div>
            </Card>
          ) : null}
          <ErrorAlert title="Could not do that" error={act.error as Error | null} />
          {r.history.length ? (
            <Card>
              <CardHeader title="History" help={<SectionHelpSlot title="Reconciliation steps" />} />
              <ol className="space-y-1 p-5 text-sm">
                {r.history.map((h) => (
                  <li key={h.id}><span className="font-medium">{EVENT_LABEL[h.kind]}</span> by {h.by ?? 'someone'} · {dateTime(h.at)}{h.note ? <span className="text-fg-muted">: {h.note}</span> : null}</li>
                ))}
              </ol>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
