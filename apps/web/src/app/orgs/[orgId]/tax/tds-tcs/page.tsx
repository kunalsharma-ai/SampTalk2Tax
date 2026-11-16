'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taxQuarterOf } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useAccounts, useOrg, useWithholdingSettings } from '@/lib/org';
import { can, type WithholdingDeposit, type WithholdingKind, type WithholdingRegister, type WithholdingRegisterRow } from '@/lib/types';

export default function WithholdingPage() {
  return (
    <Suspense>
      <Withholding />
    </Suspense>
  );
}

/** The four quarters of the tax year a date is in, plus that year's previous quarter for context. */
function quarterOptions(iso: string) {
  const q = taxQuarterOf(iso);
  const start = Number(q.label.slice(3, 7));
  const out: ReturnType<typeof taxQuarterOf>[] = [];
  for (const y of [start - 1, start]) for (const m of ['04', '07', '10', '01']) out.push(taxQuarterOf(`${m === '01' ? y + 1 : y}-${m}-15`));
  return out.filter((x) => x.from <= q.to).reverse();
}

function Withholding() {
  const { org, orgId } = useOrg();
  const settings = useWithholdingSettings();
  const params = useSearchParams();
  const router = useRouter();
  const kind: WithholdingKind = params.get('kind') === 'TCS' ? 'TCS' : 'TDS';
  const quarters = quarterOptions(today());
  const q = quarters.find((x) => x.from === params.get('quarter')) ?? quarters[0];
  const set = (next: Partial<{ kind: WithholdingKind; quarter: string }>) => router.replace(`/orgs/${orgId}/tax/tds-tcs?${new URLSearchParams({ kind, quarter: q.from, ...next }).toString()}`);
  const configured = settings.data?.configured === true;
  const reg = useQuery({ queryKey: ['withholding-register', orgId, kind, q.from], enabled: configured, queryFn: () => api<WithholdingRegister>(`/v1/orgs/${orgId}/withholding/register?kind=${kind}&from=${q.from}&to=${q.to}`) });
  const deposits = useQuery({ queryKey: ['withholding-deposits', orgId, kind], enabled: configured, queryFn: () => api<WithholdingDeposit[]>(`/v1/orgs/${orgId}/withholding/deposits?kind=${kind}`) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [challan, setChallan] = useState(false);
  if (!org) return null;
  const c = org.functionalCurrency;
  const r = reg.data;
  const pending = (r?.rows ?? []).filter((x) => x.status === 'POSTED' && Number(x.amount) > 0 && !x.deposit);
  const chosen = pending.filter((x) => selected.has(x.documentId));
  const canPost = can(org.role, 'journals.post');

  return (
    <>
      <PageHeader
        title="TDS and TCS"
        description={`The register for ${q.label}: tax ${kind === 'TDS' ? 'deducted on bills' : 'collected on invoices'}, what has been deposited, and what is still due. It is the working paper for the quarterly ${kind} statement; Talk2Tax does not file it.`}
        actions={
          <>
            <div role="tablist" aria-label="Tax" className="flex rounded-lg border border-line p-0.5">
              {(['TDS', 'TCS'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} onClick={() => { setSelected(new Set()); set({ kind: k }); }} className={`rounded-md px-3 py-1.5 text-sm ${kind === k ? 'bg-surface-hover font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>{k}</button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Quarter
              <Select className="w-72 max-w-full" value={q.from} onChange={(e) => { setSelected(new Set()); set({ quarter: e.target.value }); }}>
                {quarters.map((x) => <option key={x.from} value={x.from}>{x.label} · {quarterMonths(x.from, x.to)}</option>)}
              </Select>
            </label>
          </>
        }
      />
      {settings.data && !configured ? (
        <Card><EmptyState title="TDS and TCS are not set up" action={<Link href={`/orgs/${orgId}/settings/tds-tcs`}><Button>Set up TDS and TCS</Button></Link>}>Add your TAN and the sections you deduct or collect under.</EmptyState></Card>
      ) : null}
      {reg.error ? <Alert title="Could not load">{(reg.error as Error).message}</Alert> : null}
      {r ? (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label={kind === 'TDS' ? 'Deducted' : 'Collected'} value={<Money value={r.totals.withheld} currency={c} />} sub={plural(r.rows.filter((x) => x.status === 'POSTED').length, 'document')} />
            <Stat label="Deposited" value={<Money value={r.totals.deposited} currency={c} />} tone="positive" />
            <Stat label="To deposit" value={<Money value={r.totals.pending} currency={c} />} tone={Number(r.totals.pending) > 0 ? 'warning' : 'neutral'} />
            <Stat label="Overdue" value={<Money value={r.totals.overdue} currency={c} />} tone={Number(r.totals.overdue) > 0 ? 'negative' : 'neutral'} sub="Past the 7th of the next month" />
          </div>
          <Alert tone={r.ledger.agrees ? 'positive' : 'warning'} title={r.ledger.agrees ? `✓ Agrees with the ledger: ${r.ledger.account.code} ${r.ledger.account.name} is ${money(r.ledger.balance, c)} on ${date(r.ledger.asOf)}` : `The ledger does not agree: ${r.ledger.account.code} is ${money(r.ledger.balance, c)}, the documents say ${money(r.ledger.expected, c)}`}>
            {r.ledger.agrees ? `Tax ${kind === 'TDS' ? 'deducted' : 'collected'} to date less tax deposited to date.` : 'Something other than documents and deposits posted to this account, such as a manual journal. Find it in the general ledger.'}
          </Alert>

          <Card>
            <CardHeader
              title="To deposit"
              description={`Tax ${kind === 'TDS' ? 'deducted' : 'collected'} this quarter that no challan covers yet. Pay it to the government, then record the challan here: it posts Dr ${r.ledger.account.code} ${r.ledger.account.name}, Cr the bank.`}
              actions={canPost && pending.length ? <Button size="sm" disabled={!chosen.length} onClick={() => setChallan(true)}>Record challan{chosen.length ? ` (${chosen.length})` : ''}</Button> : null}
            />
            {pending.length ? (
              <div className="overflow-x-auto">
                <Table className="min-w-[720px]">
                  <thead><tr><Th className="w-10"><input type="checkbox" aria-label="Select all" className="accent-[var(--t2t-accent)]" checked={chosen.length === pending.length} onChange={(e) => setSelected(new Set(e.target.checked ? pending.map((x) => x.documentId) : []))} /></Th><Th>Document</Th><Th>{kind === 'TDS' ? 'Vendor' : 'Customer'}</Th><Th>Section</Th><Th>Due by</Th><Th numeric>Amount</Th></tr></thead>
                  <tbody>
                    {pending.map((x) => (
                      <tr key={x.documentId}>
                        <Td><input type="checkbox" aria-label={`Select ${x.number}`} className="accent-[var(--t2t-accent)]" checked={selected.has(x.documentId)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(x.documentId); else n.delete(x.documentId); setSelected(n); }} /></Td>
                        <Td><DocLink orgId={orgId} row={x} /><span className="block text-xs text-fg-muted">{date(x.date)}</span></Td>
                        <Td>{x.contact.name}</Td>
                        <Td className="num">{x.section.code}</Td>
                        <Td className="whitespace-nowrap">{date(x.dueDate)} {x.overdue ? <Badge tone="negative">Overdue</Badge> : null}</Td>
                        <Td numeric><Money value={x.amount} currency={c} /></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : <p className="px-5 pb-5 text-sm text-fg-muted">Nothing to deposit for {q.label}.</p>}
          </Card>

          <Card>
            <CardHeader title="By section" />
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <thead><tr><Th>Section</Th><Th numeric>Documents</Th><Th numeric>Taxed on</Th><Th numeric>{kind === 'TDS' ? 'Deducted' : 'Collected'}</Th><Th numeric>Deposited</Th><Th numeric>To deposit</Th></tr></thead>
                <tbody>
                  {r.sections.map((s) => (
                    <tr key={s.section.id}>
                      <Td><span className="num font-medium">{s.section.code}</span><span className="block text-xs text-fg-muted">{s.section.name}</span></Td>
                      <Td numeric>{s.count}</Td>
                      <Td numeric><Money value={s.base} currency={c} /></Td>
                      <Td numeric><Money value={s.amount} currency={c} /></Td>
                      <Td numeric><Money value={s.deposited} currency={c} /></Td>
                      <Td numeric><Money value={s.pending} currency={c} /></Td>
                    </tr>
                  ))}
                  {r.sections.length === 0 ? <tr><Td colSpan={6} className="py-6 text-center text-fg-muted">No {kind} this quarter.</Td></tr> : null}
                </tbody>
              </Table>
            </div>
          </Card>

          <Card>
            <CardHeader title={`${kind} register`} description="Every document with a section, including those below the threshold (they count toward it) and voided ones." />
            <div className="overflow-x-auto">
              <Table className="min-w-[1180px]">
                <thead><tr><Th>Date</Th><Th>Document</Th><Th>{kind === 'TDS' ? 'Deductee' : 'Collectee'}</Th><Th>PAN</Th><Th>Section</Th><Th numeric>Amount counted</Th><Th numeric>Taxed on</Th><Th numeric>Rate</Th><Th numeric>{kind}</Th><Th>Deposit</Th></tr></thead>
                <tbody>
                  {r.rows.map((x) => (
                    <tr key={x.documentId} className={x.status === 'VOID' ? 'opacity-60' : ''}>
                      <Td className="whitespace-nowrap">{date(x.date)}</Td>
                      <Td className="whitespace-nowrap"><DocLink orgId={orgId} row={x} />{x.status === 'VOID' ? <Badge className="ml-1">Void</Badge> : null}</Td>
                      <Td className="whitespace-nowrap">{x.contact.name}</Td>
                      <Td className="num">{x.pan ?? <Badge tone="warning">No PAN</Badge>}</Td>
                      <Td className="num whitespace-nowrap">{x.section.code}</Td>
                      <Td numeric><Money value={x.subject} currency={c} /></Td>
                      <Td numeric><Money value={x.base} currency={c} /></Td>
                      <Td numeric>{x.rate}%</Td>
                      <Td numeric><Money value={x.amount} currency={c} /></Td>
                      <Td className="whitespace-nowrap text-sm">{x.deposit ? <>{x.deposit.number}<span className="block text-xs text-fg-muted">{date(x.deposit.date)}</span></> : Number(x.amount) > 0 && x.status === 'POSTED' ? <span className="text-warning">Due {date(x.dueDate)}</span> : '—'}</Td>
                    </tr>
                  ))}
                  {r.rows.length === 0 ? <tr><Td colSpan={10} className="py-6 text-center text-fg-muted">No documents with {kind} this quarter.</Td></tr> : null}
                </tbody>
              </Table>
            </div>
          </Card>

          <Deposits orgId={orgId} kind={kind} rows={deposits.data ?? []} c={c} canVoid={can(org.role, 'journals.reverse')} />
        </div>
      ) : null}
      <ChallanDialog open={challan} onClose={(done) => { setChallan(false); if (done) setSelected(new Set()); }} kind={kind} rows={chosen} c={c} />
    </>
  );
}

function quarterMonths(from: string, to: string) {
  const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${month(from)} to ${monthShort(to)}`;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function monthShort(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function DocLink({ orgId, row }: { orgId: string; row: WithholdingRegisterRow }) {
  return <Link className="num text-accent hover:underline" href={`/orgs/${orgId}/${row.kind === 'BILL' ? 'purchases/bills' : 'sales/invoices'}/${row.documentId}`}>{row.number}</Link>;
}

function ChallanDialog({ open, onClose, kind, rows, c }: { open: boolean; onClose: (done: boolean) => void; kind: WithholdingKind; rows: WithholdingRegisterRow[]; c: string }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [form, setForm] = useState({ depositDate: today(), bankAccountId: '', challanReference: '', interestAmount: '', interestAccountId: '' });
  const total = rows.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0);
  const save = useMutation({
    mutationFn: () => api<WithholdingDeposit>(`/v1/orgs/${orgId}/withholding/deposits`, { method: 'POST', body: { kind, depositDate: form.depositDate, bankAccountId: form.bankAccountId, challanReference: form.challanReference, documentIds: rows.map((x) => x.documentId), interestAmount: form.interestAmount || undefined, interestAccountId: form.interestAmount ? form.interestAccountId : null } }),
    onSuccess: async () => {
      for (const k of ['withholding-register', 'withholding-deposits', 'document', 'dashboard']) await qc.invalidateQueries({ queryKey: [k, orgId] });
      onClose(true);
    },
  });
  if (!org) return null;
  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && (a.subtype === 'BANK' || a.subtype === 'CASH'));
  const expenses = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.type === 'EXPENSE');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)} title={`Record ${kind} challan`} description={`${rows.length} document${rows.length === 1 ? '' : 's'}, ${money((total / 100).toFixed(2), c)} of ${kind}. Enter the challan as the bank or the income-tax portal issued it.`}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Paid on">{(p) => <Input {...p} type="date" value={form.depositDate} onChange={(e) => setForm({ ...form, depositDate: e.target.value })} />}</Field>
        <Field label="Paid from">{(p) => <Select {...p} value={form.bankAccountId} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}><option value="">Choose a bank account…</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        <div className="sm:col-span-2"><Field label="Challan reference" hint="For example the CIN, or the BSR code, date and serial number.">{(p) => <Input {...p} value={form.challanReference} maxLength={100} onChange={(e) => setForm({ ...form, challanReference: e.target.value })} />}</Field></div>
        <Field label="Interest paid (optional)">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder="0.00" value={form.interestAmount} onChange={(e) => /^\d{0,12}(\.\d{0,2})?$/.test(e.target.value) && setForm({ ...form, interestAmount: e.target.value })} />}</Field>
        <Field label="Interest account">{(p) => <Select {...p} disabled={!form.interestAmount} value={form.interestAccountId} onChange={(e) => setForm({ ...form, interestAccountId: e.target.value })}><option value="">Choose…</option>{expenses.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        {save.error ? <div className="sm:col-span-2"><Alert title="Not recorded">{save.error.message}{save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-inside list-disc">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!form.bankAccountId || !form.challanReference.trim() || (!!form.interestAmount && !form.interestAccountId)}>Record challan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Deposits({ orgId, kind, rows, c, canVoid }: { orgId: string; kind: WithholdingKind; rows: WithholdingDeposit[]; c: string; canVoid: boolean }) {
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState<WithholdingDeposit | null>(null);
  const [reason, setReason] = useState('');
  const v = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/withholding/deposits/${voiding!.id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      for (const k of ['withholding-register', 'withholding-deposits', 'document']) await qc.invalidateQueries({ queryKey: [k, orgId] });
      setVoiding(null);
    },
  });
  return (
    <Card>
      <CardHeader title={`${kind} challans`} description="Deposits recorded, newest first. Voiding one reverses its journal and puts its documents back to deposit." />
      <div className="overflow-x-auto">
        <Table className="min-w-[980px]">
          <thead><tr><Th>Deposit</Th><Th>Paid on</Th><Th>Challan</Th><Th>Bank</Th><Th numeric>Tax</Th><Th numeric>Interest</Th><Th>Documents</Th><Th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className={d.status === 'VOID' ? 'opacity-60' : ''}>
                <Td className="whitespace-nowrap"><Link className="num text-accent hover:underline" href={`/orgs/${orgId}/journals/${d.journalEntryId}`}>{d.number}</Link>{d.status === 'VOID' ? <Badge className="ml-1">Void</Badge> : null}</Td>
                <Td className="whitespace-nowrap">{date(d.depositDate)}</Td>
                <Td className="num text-sm">{d.challanReference}</Td>
                <Td className="text-sm">{d.bankAccount.code} · {d.bankAccount.name}</Td>
                <Td numeric><Money value={d.taxAmount} currency={c} /></Td>
                <Td numeric><Money value={d.interestAmount} currency={c} /></Td>
                <Td className="text-sm">{d.items.map((i) => i.number).join(', ')}</Td>
                <Td className="text-right">{canVoid && d.status === 'POSTED' ? <Button size="sm" variant="ghost" onClick={() => { v.reset(); setReason(''); setVoiding(d); }}>Void</Button> : null}</Td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><Td colSpan={8} className="py-6 text-center text-fg-muted">No {kind} challans recorded yet.</Td></tr> : null}
          </tbody>
        </Table>
      </div>
      <Dialog open={!!voiding} onOpenChange={(o) => !o && setVoiding(null)} title={`Void ${voiding?.number}`} description="Posts a reversal dated today. The documents it covered will show as still to deposit.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); v.mutate(); }}>
          <Field label="Reason">{(p) => <Input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
          {v.error ? <Alert title="Not voided">{v.error.message}</Alert> : null}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button><Button type="submit" variant="danger" loading={v.isPending} disabled={reason.trim().length < 3}>Void deposit</Button></div>
        </form>
      </Dialog>
    </Card>
  );
}
