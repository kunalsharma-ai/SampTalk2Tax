'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AGEING_BUCKETS, type AgeingBucket } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { BadDebtInvoice, BadDebtOverview, Rates, WriteOff } from '@/lib/bad-debts';
import { date, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';

export default function BadDebtsPage() {
  return (
    <Suspense fallback={null}>
      <BadDebts />
    </Suspense>
  );
}

function BadDebts() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [asOf, setAsOf] = useState(today());
  const [editing, setEditing] = useState(false);
  const [provideOpen, setProvideOpen] = useState(false);
  const [memo, setMemo] = useState('');
  const [doubtful, setDoubtful] = useState<BadDebtInvoice | null>(null);
  const [writeOff, setWriteOff] = useState<BadDebtInvoice | null>(null);
  const [reverse, setReverse] = useState<WriteOff | null>(null);
  const base = `/v1/orgs/${orgId}/bad-debts`;
  const q = useQuery({ queryKey: ['bad-debts', orgId, asOf], queryFn: () => api<BadDebtOverview>(`${base}?asOf=${asOf}`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['bad-debts', orgId] });
    await qc.invalidateQueries({ queryKey: ['documents', orgId] });
  };
  const provide = useMutation({
    mutationFn: () => api<{ reference: string; adjustment: string; journalEntryId: string | null }>(`${base}/provisions`, { method: 'POST', body: { asOf, memo: memo || null } }),
    onSuccess: async () => {
      setProvideOpen(false);
      setMemo('');
      await refresh();
    },
  });
  const clearDoubtful = useMutation({ mutationFn: (id: string) => api(`${base}/doubtful/${id}`, { method: 'DELETE' }), onSuccess: refresh });

  // Opened from an invoice's Write off button.
  const wanted = params.get('writeOff');
  useEffect(() => {
    if (!wanted || !q.data) return;
    const inv = q.data.invoices.find((i) => i.id === wanted);
    if (inv && q.data.settings) setWriteOff(inv);
    router.replace(`/orgs/${orgId}/sales/bad-debts`);
  }, [wanted, q.data, orgId, router]);

  if (!org) return null;
  const o = q.data;
  const c = org.functionalCurrency;
  const adj = o ? Number(o.preview.adjustment) : 0;
  return (
    <>
      <PageHeader
        title="Bad debts"
        description="The allowance for doubtful debts worked out from the receivables ageing, and invoices written off when a customer will not pay. Every figure here posts through the journal, dated as you choose."
        actions={
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            As of
            <Input type="date" className="w-40" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
          </label>
        }
      />
      <ErrorAlert title="Could not load bad debts" error={q.error} />
      <ErrorAlert title="The provision was not posted" error={provide.error} />
      {provide.data ? (
        <Alert tone="positive" title={`${provide.data.reference} saved`}>
          {provide.data.journalEntryId ? (
            <>Posted {Number(provide.data.adjustment) > 0 ? 'an increase' : 'a release'} of <Money value={provide.data.adjustment.replace('-', '')} currency={c} />. <Link className="text-accent underline" href={`/orgs/${orgId}/journals/${provide.data.journalEntryId}`}>Open the journal</Link></>
          ) : 'The allowance already matched; nothing was posted.'}
        </Alert>
      ) : null}
      {o && (!o.settings || editing) ? <SettingsCard o={o} onDone={async () => { setEditing(false); await refresh(); }} onCancel={o.settings ? () => setEditing(false) : undefined} /> : null}
      {o ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Receivables open" value={<Money value={o.preview.open} currency={c} />} tone="accent" sub={`${o.invoices.length} open ${o.invoices.length === 1 ? 'invoice' : 'invoices'} on ${date(asOf)}`} />
            <Stat label="Allowance needed" value={<Money value={o.preview.total} currency={c} />} tone="violet" sub="By the matrix and specific provisions" />
            <Stat label="Allowance in the books" value={<Money value={o.preview.carried} currency={c} />} sub={o.settings?.allowanceAccount ? `${o.settings.allowanceAccount.code} ${o.settings.allowanceAccount.name}` : 'Accounts not set'} />
            <Stat label="To post" value={<Money value={o.preview.adjustment} currency={c} />} tone={adj === 0 ? 'positive' : 'warning'} sub={adj > 0 ? 'An increase in the allowance' : adj < 0 ? 'A release of the allowance' : 'The books already match'} />
          </div>

          <Card>
            <CardHeader
              title="Provision matrix"
              description="Each ageing bucket's open amount times its percentage, plus invoices provided for on their own. Amounts in the functional currency at each invoice's rate."
              actions={
                o.can.manage && o.settings ? (
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Settings</Button>
                    <Button size="sm" disabled={adj === 0} onClick={() => { provide.reset(); setProvideOpen(true); }}>Post provision…</Button>
                  </div>
                ) : null
              }
            />
            <Table aria-label="Provision matrix">
              <thead>
                <tr><Th>Bucket</Th><Th numeric>Invoices</Th><Th numeric>Open</Th><Th numeric>Rate</Th><Th numeric>Provision</Th></tr>
              </thead>
              <tbody>
                {o.preview.buckets.map((b) => (
                  <Tr key={b.bucket}>
                    <Td>{o.labels[b.bucket]}</Td>
                    <Td numeric>{b.invoices}</Td>
                    <Td numeric><Money value={b.open} currency={c} /></Td>
                    <Td numeric>{b.rate}%</Td>
                    <Td numeric><Money value={b.provision} currency={c} /></Td>
                  </Tr>
                ))}
                <Tr>
                  <Td>Specific provisions</Td>
                  <Td numeric>{o.preview.specific.invoices}</Td>
                  <Td numeric><Money value={o.preview.specific.open} currency={c} /></Td>
                  <Td numeric>Own %</Td>
                  <Td numeric><Money value={o.preview.specific.provision} currency={c} /></Td>
                </Tr>
              </tbody>
              <tfoot>
                <tr>
                  <Td className="font-semibold">Allowance needed</Td>
                  <Td />
                  <Td numeric className="font-semibold"><Money value={o.preview.open} currency={c} /></Td>
                  <Td />
                  <Td numeric className="font-semibold"><Money value={o.preview.total} currency={c} /></Td>
                </tr>
              </tfoot>
            </Table>
          </Card>

          <Card className="mt-6">
            <CardHeader title="Open invoices" description="Every invoice still owed on the date, oldest first. Mark one doubtful to provide for it at its own percentage, or write off what will not be paid." />
            {o.invoices.length === 0 ? (
              <EmptyState title="Nothing is owed on this date">Posted invoices with an amount still due appear here.</EmptyState>
            ) : (
              <Table aria-label="Open invoices">
                <thead>
                  <tr><Th>Invoice</Th><Th>Customer</Th><Th>Due</Th><Th>Bucket</Th><Th numeric>Open</Th><Th numeric>Provision</Th><Th><span className="sr-only">Actions</span></Th></tr>
                </thead>
                <tbody>
                  {o.invoices.map((i) => (
                    <Tr key={i.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${i.id}`}>{i.number}</Link>{i.doubtful ? <Badge tone="negative" className="ml-2">Doubtful {i.doubtful.percent}%</Badge> : null}</Td>
                      <Td>{i.contactName}</Td>
                      <Td>{date(i.dueDate)}<span className="block text-xs text-fg-muted">{i.daysOverdue ? `${i.daysOverdue} days overdue` : 'Not yet due'}</span></Td>
                      <Td className="text-sm">{o.labels[i.bucket]}</Td>
                      <Td numeric><Money value={i.open} currency={c} />{i.currency !== c ? <span className="block text-xs text-fg-muted"><Money value={i.foreignOpen} currency={i.currency} /></span> : null}</Td>
                      <Td numeric><Money value={i.provision} currency={c} /></Td>
                      <Td className="whitespace-nowrap text-right">
                        {o.can.markDoubtful ? (
                          i.doubtful ? (
                            <Button size="sm" variant="ghost" onClick={() => clearDoubtful.mutate(i.id)}>Not doubtful</Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setDoubtful(i)}>Mark doubtful…</Button>
                          )
                        ) : null}
                        {o.can.manage && o.settings ? <Button size="sm" variant="secondary" onClick={() => setWriteOff(i)}>Write off…</Button> : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card className="mt-6">
            <CardHeader title="Write-offs" description="Invoices written off as bad debts, newest first. Reversing one brings the amount back as owed, for example when the customer pays after all." />
            {o.writeOffs.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-fg-muted">No invoice has been written off.</p>
            ) : (
              <Table aria-label="Write-offs">
                <thead>
                  <tr><Th>Write-off</Th><Th>Invoice</Th><Th>Customer</Th><Th>Charged to</Th><Th>Reason</Th><Th numeric>Amount</Th><Th><span className="sr-only">Actions</span></Th></tr>
                </thead>
                <tbody>
                  {o.writeOffs.map((w) => (
                    <Tr key={w.id}>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${w.journalEntryId}`}>{w.reference}</Link>
                        <span className="block text-xs text-fg-muted">{date(w.date)}</span>
                        {w.status === 'REVERSED' ? <Badge className="mt-1">Reversed {w.reversedOn ? date(w.reversedOn) : ''}</Badge> : null}
                      </Td>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${w.invoice.id}`}>{w.invoice.number}</Link></Td>
                      <Td>{w.contact.name}</Td>
                      <Td className="text-sm">{w.account ? `${w.account.code} ${w.account.name}` : '—'}</Td>
                      <Td className="max-w-xs text-sm">{w.reason}{w.reversalReason ? <span className="block text-xs text-fg-muted">Reversed: {w.reversalReason}</span> : null}</Td>
                      <Td numeric><Money value={w.amount} currency={w.currency} />{w.currency !== c ? <span className="block text-xs text-fg-muted"><Money value={w.functionalAmount} currency={c} /></span> : null}</Td>
                      <Td className="text-right">{o.can.manage && w.status === 'ACTIVE' ? <Button size="sm" variant="ghost" onClick={() => setReverse(w)}>Reverse…</Button> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card className="mt-6">
            <CardHeader title="Provision history" description="Each time the allowance was worked out: what the receivables needed, what the books carried, and the posting between them." />
            {o.provisions.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-fg-muted">No provision has been posted yet.</p>
            ) : (
              <Table aria-label="Provision history">
                <thead>
                  <tr><Th>Run</Th><Th>As of</Th><Th numeric>Needed</Th><Th numeric>In the books</Th><Th numeric>Posted</Th><Th>Note</Th></tr>
                </thead>
                <tbody>
                  {o.provisions.map((p) => (
                    <Tr key={p.id}>
                      <Td>{p.reference}</Td>
                      <Td>{date(p.asOf)}</Td>
                      <Td numeric><Money value={p.required} currency={c} /></Td>
                      <Td numeric><Money value={p.carried} currency={c} /></Td>
                      <Td numeric>{p.journalEntryId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${p.journalEntryId}`}><Money value={p.adjustment} currency={c} /></Link> : <span className="text-fg-muted">Nothing</span>}</Td>
                      <Td className="text-sm">{p.memo ?? ''}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Dialog open={provideOpen} onOpenChange={setProvideOpen} title="Post the provision" description={`Brings the allowance to ${o.preview.total} ${c} as of ${date(asOf)}: ${adj > 0 ? 'Dr bad debts, Cr allowance' : 'Dr allowance, Cr bad debts'} for ${o.preview.adjustment.replace('-', '')} ${c}.`}>
            <Field label="Note (optional)">{(p) => <Input {...p} maxLength={400} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Quarter-end review" />}</Field>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setProvideOpen(false)}>Cancel</Button>
              <Button loading={provide.isPending} onClick={() => provide.mutate()}>Post provision</Button>
            </div>
          </Dialog>
          {doubtful ? <DoubtfulDialog inv={doubtful} onClose={() => setDoubtful(null)} onDone={refresh} /> : null}
          {writeOff ? <WriteOffDialog inv={writeOff} o={o} onClose={() => setWriteOff(null)} onDone={refresh} /> : null}
          {reverse ? <ReverseDialog w={reverse} onClose={() => setReverse(null)} onDone={refresh} /> : null}
        </>
      ) : null}
    </>
  );
}

function SettingsCard({ o, onDone, onCancel }: { o: BadDebtOverview; onDone: () => Promise<void>; onCancel?: () => void }) {
  const { orgId } = useOrg();
  const accounts = useAccounts();
  const s = o.settings;
  const [expense, setExpense] = useState(s?.expenseAccount?.id ?? o.suggestedAccounts?.expenseAccount?.id ?? '');
  const [allowance, setAllowance] = useState(s?.allowanceAccount?.id ?? o.suggestedAccounts?.allowanceAccount?.id ?? '');
  const [rates, setRates] = useState<Rates>(s?.rates ?? o.defaultRates);
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/bad-debts/settings`, { method: 'PUT', body: { expenseAccountId: expense, allowanceAccountId: allowance, rates } }), onSuccess: onDone });
  const make = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/bad-debts/settings/default-accounts`, { method: 'POST' }), onSuccess: onDone });
  const list = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive);
  return (
    <Card className="mt-4">
      <CardHeader title="Bad-debt settings" description="The accounts bad debts post to, and the percentage of each ageing bucket expected not to be collected. Base the percentages on your own history of losses." />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Bad-debt expense account">{(p) => (
          <Select {...p} value={expense} onChange={(e) => setExpense(e.target.value)}>
            <option value="">Choose…</option>
            {list.filter((a) => a.type === 'EXPENSE').map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Allowance for doubtful debts (contra-asset)">{(p) => (
          <Select {...p} value={allowance} onChange={(e) => setAllowance(e.target.value)}>
            <option value="">Choose…</option>
            {list.filter((a) => a.type === 'ASSET').map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        )}</Field>
        <div className="sm:col-span-2">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Provision matrix (percent of the open amount)</p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {AGEING_BUCKETS.map((b: AgeingBucket) => (
              <label key={b} className="flex flex-col gap-1 text-xs text-fg-muted">
                {o.labels[b]}
                <Input inputMode="decimal" className="text-right" value={rates[b]} onChange={(e) => /^\d{0,3}(\.\d{0,4})?$/.test(e.target.value) && setRates({ ...rates, [b]: e.target.value })} />
              </label>
            ))}
          </div>
        </div>
      </div>
      <ErrorAlert title="Settings were not saved" error={save.error ?? make.error} />
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
        {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        {!s ? <Button variant="secondary" loading={make.isPending} onClick={() => make.mutate()}>Create the usual accounts</Button> : null}
        <Button loading={save.isPending} disabled={!expense || !allowance || AGEING_BUCKETS.some((b) => rates[b] === '')} onClick={() => save.mutate()}>Save settings</Button>
      </div>
    </Card>
  );
}

function DoubtfulDialog({ inv, onClose, onDone }: { inv: BadDebtInvoice; onClose: () => void; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const [percent, setPercent] = useState('100');
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/bad-debts/doubtful/${inv.id}`, { method: 'PUT', body: { percent, reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Mark ${inv.number} doubtful`} description="Provide for this invoice at its own percentage instead of its ageing bucket's, for example when the customer is in trouble. Nothing is posted until the next provision.">
      <div className="flex flex-col gap-4">
        <Field label="Percentage to provide">{(p) => <Input {...p} inputMode="decimal" value={percent} onChange={(e) => /^\d{0,3}(\.\d{0,4})?$/.test(e.target.value) && setPercent(e.target.value)} />}</Field>
        <Field label="Why">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer has gone into insolvency" />}</Field>
        <ErrorAlert title="Not saved" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={m.isPending} disabled={!percent || !reason.trim()} onClick={() => m.mutate()}>Mark doubtful</Button>
        </div>
      </div>
    </Dialog>
  );
}

function WriteOffDialog({ inv, o, onClose, onDone }: { inv: BadDebtInvoice; o: BadDebtOverview; onClose: () => void; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const [d, setD] = useState(o.asOf);
  const [amount, setAmount] = useState(inv.foreignOpen);
  const [against, setAgainst] = useState<'EXPENSE' | 'ALLOWANCE'>(Number(o.preview.carried) > 0 ? 'ALLOWANCE' : 'EXPENSE');
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/bad-debts/write-offs`, { method: 'POST', body: { documentId: inv.id, date: d, amount, against, reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Write off ${inv.number}`} description={`${inv.contactName} still owes ${inv.foreignOpen} ${inv.currency}. The amount written off leaves receivables at the invoice's own rate; GST already charged is not reduced.`}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">{(p) => <Input {...p} type="date" min={inv.date} value={d} onChange={(e) => setD(e.target.value)} />}</Field>
          <Field label={`Amount (${inv.currency})`}>{(p) => <Input {...p} inputMode="decimal" className="text-right" value={amount} onChange={(e) => /^\d{0,18}(\.\d{0,6})?$/.test(e.target.value) && setAmount(e.target.value)} />}</Field>
        </div>
        <Field label="Charge it to">{(p) => (
          <Select {...p} value={against} onChange={(e) => setAgainst(e.target.value as 'EXPENSE' | 'ALLOWANCE')}>
            <option value="ALLOWANCE">The allowance for doubtful debts ({o.settings?.allowanceAccount?.code}), already provided</option>
            <option value="EXPENSE">Bad-debt expense ({o.settings?.expenseAccount?.code}), not provided before</option>
          </Select>
        )}</Field>
        <Field label="Reason">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer dissolved; liquidator confirmed nothing will be paid" />}</Field>
        <ErrorAlert title="Not written off" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={m.isPending} disabled={!amount || !reason.trim() || !d} onClick={() => m.mutate()}>Write off</Button>
        </div>
      </div>
    </Dialog>
  );
}

function ReverseDialog({ w, onClose, onDone }: { w: WriteOff; onClose: () => void; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const [d, setD] = useState(today() < w.date ? w.date : today());
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/bad-debts/write-offs/${w.id}/reverse`, { method: 'POST', body: { date: d, reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Reverse ${w.reference}`} description={`${w.amount} ${w.currency} of ${w.invoice.number} becomes owed again, and the write-off journal is reversed on the date you choose.`}>
      <div className="flex flex-col gap-4">
        <Field label="Date">{(p) => <Input {...p} type="date" min={w.date} value={d} onChange={(e) => setD(e.target.value)} />}</Field>
        <Field label="Reason">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer paid after all" />}</Field>
        <ErrorAlert title="Not reversed" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={m.isPending} disabled={!reason.trim()} onClick={() => m.mutate()}>Reverse write-off</Button>
        </div>
      </div>
    </Dialog>
  );
}
