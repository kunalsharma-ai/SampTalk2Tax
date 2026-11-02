'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { acct, today, type AccrualList, type AccrualRow, type DeferralAccounts, type EntryRef } from '@/lib/deferrals';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

const lastMonth = () => {
  const t = today();
  const y = +t.slice(0, 4);
  const m = +t.slice(5, 7) - 1;
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
};

export default function AccrualsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [month, setMonth] = useState('');
  const q = useQuery({ queryKey: ['accruals', orgId, month], queryFn: () => api<AccrualList>(`/v1/orgs/${orgId}/deferrals/accruals${month ? `?month=${month}` : ''}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['accruals', orgId] });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = q.data;
  const je = (e: EntryRef) => (e ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>#{e.entryNumber}</Link> : null);
  return (
    <>
      <PageHeader
        title="Accruals"
        description="Expenses incurred and income earned in a month that are not billed yet. Each accrual is posted on the last day of its month and reversed automatically on the first day of the next, so the real bill or invoice lands against it when it arrives."
      />
      <ErrorAlert title="Could not load accruals" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Accrued expenses" value={<Money value={r.totals.expense} currency={cur} />} tone="accent" sub={month ? undefined : 'All months shown'} />
            <Stat label="Accrued income" value={<Money value={r.totals.income} currency={cur} />} tone="violet" />
          </div>
          {r.can.manage ? <NewAccrual orgId={orgId} onDone={refresh} /> : null}
          <label className="mb-3 flex w-fit items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Month
            <Input type="month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
            {month ? <Button size="sm" variant="ghost" onClick={() => setMonth('')}>All</Button> : null}
          </label>
          {r.accruals.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Accruals">
                <thead>
                  <tr>
                    <Th>Accrual</Th>
                    <Th>Month</Th>
                    <Th>Accounts</Th>
                    <Th numeric>Amount</Th>
                    <Th>Posted</Th>
                    <Th>Reversed</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {r.accruals.map((a) => (
                    <AccrualLine key={a.id} a={a} cur={cur} je={je} manage={r.can.manage} orgId={orgId} onDone={refresh} />
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card><EmptyState title="No accruals">{month ? 'Nothing was accrued in this month.' : 'Accrue an expense or income at month end to have it in the right month.'}</EmptyState></Card>
          )}
        </>
      ) : null}
    </>
  );
}

function AccrualLine({ a, cur, je, manage, orgId, onDone }: { a: AccrualRow; cur: string; je: (e: EntryRef) => React.ReactNode; manage: boolean; orgId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const cancel = useMutation({ mutationFn: () => api<AccrualRow>(`/v1/orgs/${orgId}/deferrals/accruals/${a.id}/cancel`, { method: 'POST', body: { note } }), onSuccess: () => { setOpen(false); onDone(); } });
  return (
    <>
      <Tr>
        <Td>
          <span className="font-medium">{a.reference}</span> {a.description}
          <span className="block text-xs text-fg-faint">{a.kind === 'EXPENSE' ? 'Accrued expense' : 'Accrued income'}{a.counterparty ? ` · ${a.counterparty}` : ''} · {a.createdBy}</span>
        </Td>
        <Td className="whitespace-nowrap">{a.monthName}</Td>
        <Td className="text-xs">{acct(a.pnlAccount)} / {acct(a.balanceAccount)}</Td>
        <Td numeric><Money value={a.amount} currency={cur} /></Td>
        <Td className="whitespace-nowrap text-xs">{je(a.entry)} {a.entry ? date(a.entry.date) : null}</Td>
        <Td className="whitespace-nowrap text-xs">{je(a.reversal)} {a.reversal ? date(a.reversal.date) : null}</Td>
        <Td>{a.status === 'POSTED' ? <Badge tone="positive">Posted</Badge> : <Badge>Cancelled by {a.cancel?.by}</Badge>}</Td>
        <Td>{manage && a.status === 'POSTED' && !open ? <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Cancel…</Button> : null}</Td>
      </Tr>
      {a.cancel ? (
        <Tr>
          <Td colSpan={8} className="text-xs text-fg-muted">Cancelled: {a.cancel.note} · undone by {je(a.cancel.entry)} and {je(a.cancel.reversal)}</Td>
        </Tr>
      ) : null}
      {open ? (
        <Tr>
          <Td colSpan={8}>
            <div className="flex flex-col gap-2" aria-label={`Cancel ${a.reference}`}>
              <p className="text-sm text-fg-muted">Cancelling posts the opposite of the accrual on its date, and the accrual again on its reversal&apos;s date, so both months come back to where they were.</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Why">{(p) => <Input {...p} className="w-96" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
                <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel {a.reference}</Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button>
              </div>
              <ErrorAlert title="Not cancelled" error={cancel.error} />
            </div>
          </Td>
        </Tr>
      ) : null}
    </>
  );
}

function NewAccrual({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const accounts = useQuery({ queryKey: ['deferral-accounts', orgId], queryFn: () => api<DeferralAccounts>(`/v1/orgs/${orgId}/deferrals/accounts`) });
  const [f, setF] = useState({ kind: 'EXPENSE' as 'EXPENSE' | 'INCOME', description: '', counterparty: '', month: lastMonth(), pnlAccountId: '', balanceAccountId: '', amount: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const acc = accounts.data;
  const expense = f.kind === 'EXPENSE';
  const pnlList = expense ? acc?.expense : acc?.revenue;
  const balList = expense ? acc?.accruedLiability : acc?.accruedIncome;
  const pnlId = (pnlList ?? []).some((x) => x.id === f.pnlAccountId) ? f.pnlAccountId : pnlList?.[0]?.id ?? '';
  const balId = (balList ?? []).some((x) => x.id === f.balanceAccountId) ? f.balanceAccountId : balList?.find((x) => x.code === '2200')?.id ?? balList?.[0]?.id ?? '';
  const save = useMutation({
    mutationFn: () => api<AccrualRow>(`/v1/orgs/${orgId}/deferrals/accruals`, { method: 'POST', body: { kind: f.kind, description: f.description, counterparty: f.counterparty || null, month: f.month, pnlAccountId: pnlId, balanceAccountId: balId, amount: f.amount.replace(/,/g, '') } }),
    onSuccess: () => {
      setF((x) => ({ ...x, description: '', counterparty: '', amount: '' }));
      onDone();
    },
  });
  return (
    <Card className="mb-4 p-4" aria-label="Post an accrual">
      <CardHeader title="Post an accrual" description="Posted on the last day of the month, with its reversal on the first day of the next." />
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field label="Kind">
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                <option value="EXPENSE">Accrued expense (not billed yet)</option>
                <option value="INCOME">Accrued income (not invoiced yet)</option>
              </Select>
            )}
          </Field>
          <Field label="What for">{(p) => <Input {...p} value={f.description} onChange={set('description')} maxLength={200} required />}</Field>
          <Field label={expense ? 'Supplier' : 'Customer'}>{(p) => <Input {...p} value={f.counterparty} onChange={set('counterparty')} maxLength={200} />}</Field>
          <Field label="Month">{(p) => <Input {...p} type="month" value={f.month} max={today().slice(0, 7)} onChange={set('month')} required />}</Field>
          <Field label={expense ? 'Expense account' : 'Revenue account'}>{(p) => <Select {...p} value={pnlId} onChange={set('pnlAccountId')}>{pnlList?.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
          <Field label={expense ? 'Accrued liability account' : 'Accrued income account'}>{(p) => <Select {...p} value={balId} onChange={set('balanceAccountId')}>{balList?.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
          <Field label="Amount">{(p) => <Input {...p} inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0.00" required />}</Field>
        </div>
        {acc && !balList?.length ? <p className="text-sm text-warning">{expense ? 'Add an accrued liability account to the chart of accounts first.' : 'Add an accrued income account (an other current asset) to the chart of accounts first.'}</p> : null}
        <ErrorAlert title="Not posted" error={save.error} />
        <div>
          <Button type="submit" loading={save.isPending} disabled={!pnlId || !balId}>Post accrual</Button>
        </div>
      </form>
    </Card>
  );
}
