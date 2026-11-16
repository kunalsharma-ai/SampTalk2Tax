'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { acct, METHOD, today, type EntryRef, type LoanAccounts, type LoanDetail, type LoanEvent } from '@/lib/loans';
import { useOrg } from '@/lib/org';

type Tab = 'repay' | 'prepay' | 'rate';

export default function LoanPage() {
  const { org, orgId } = useOrg();
  const { loanId } = useParams<{ loanId: string }>();
  const qc = useQueryClient();
  const key = ['loan', orgId, loanId];
  const q = useQuery({ queryKey: key, queryFn: () => api<LoanDetail>(`/v1/orgs/${orgId}/loans/${loanId}`) });
  const done = (l: LoanDetail) => {
    qc.setQueryData(key, l);
    void qc.invalidateQueries({ queryKey: ['loans', orgId] });
  };
  if (!org) return null;
  const l = q.data;
  const cur = org.functionalCurrency;
  const je = (e: EntryRef) => (e ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>#{e.entryNumber}</Link> : null);
  return (
    <>
      <PageHeader title={l ? `${l.reference} ${l.name}` : 'Loan'} description={l ? [l.lender, METHOD[l.method], l.accountNumber ? `A/c ${l.accountNumber}` : null].filter(Boolean).join(' · ') : undefined} />
      <ErrorAlert title="Could not load the loan" error={q.error} />
      {l ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Owed" value={<Money value={l.balance} currency={cur} />} tone="accent" sub={<>of <Money value={l.principal} currency={cur} /> borrowed</>} />
            <Stat label="Next installment" value={l.next ? <Money value={l.next.payment} currency={cur} /> : '—'} sub={l.next ? `No. ${l.next.no}, due ${date(l.next.dueDate)}` : l.status === 'CLOSED' ? `Repaid on ${date(l.closedOn!)}` : undefined} tone={l.overdue.count ? 'warning' : 'neutral'} />
            <Stat label="Interest paid" value={<Money value={l.paid.interest} currency={cur} />} tone="violet" sub={`${l.paid.installments} installments · ${l.remaining.installments} to go`} />
            <Stat label="Due within 12 months" value={<Money value={l.maturity.current} currency={cur} />} sub={<>Later: <Money value={l.maturity.nonCurrent} currency={cur} /></>} />
          </div>
          {l.overdue.count ? (
            <div className="mb-4">
              <Alert tone="warning" title={`${l.overdue.count} ${l.overdue.count === 1 ? 'installment is' : 'installments are'} due and not recorded`}>
                <Money value={l.overdue.amount} currency={cur} /> in all. Record them in order below once they are paid, or check with the lender.
              </Alert>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="p-4">
              <CardHeader title="Terms" />
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-fg-muted">Interest rate</dt>
                <dd>{l.annualRate}% a year{l.annualRate !== l.originalRate ? <span className="block text-xs text-fg-faint">Started at {l.originalRate}%</span> : null}</dd>
                <dt className="text-fg-muted">{l.method === 'EMI' ? 'EMI' : 'Principal each month'}</dt>
                <dd><Money value={l.installment} currency={cur} /></dd>
                <dt className="text-fg-muted">Term</dt>
                <dd>{l.months} months{l.lastNo === null && l.status === 'ACTIVE' ? <span className="block text-xs text-fg-faint">Now runs until repaid</span> : null}</dd>
                <dt className="text-fg-muted">Received</dt>
                <dd>{date(l.disbursementDate)} {l.disbursementEntry ? je(l.disbursementEntry) : <span className="text-xs text-fg-faint">(already in the books)</span>}</dd>
                <dt className="text-fg-muted">First installment</dt>
                <dd>{date(l.firstDueDate)}</dd>
                <dt className="text-fg-muted">Ends</dt>
                <dd>{l.endsOn ? date(l.endsOn) : '—'}</dd>
                <dt className="text-fg-muted">Loan account</dt>
                <dd>{acct(l.accounts.liability)}</dd>
                <dt className="text-fg-muted">Interest to</dt>
                <dd>{acct(l.accounts.interest)}</dd>
                <dt className="text-fg-muted">Paid from</dt>
                <dd>{acct(l.accounts.bank)}</dd>
                <dt className="text-fg-muted">Added by</dt>
                <dd>{l.createdBy}</dd>
              </dl>
              {l.notes ? <p className="mt-3 text-sm text-fg-muted">{l.notes}</p> : null}
            </Card>
            <div className="xl:col-span-2">{l.can.manage && l.status === 'ACTIVE' ? <Actions l={l} orgId={orgId} cur={cur} onDone={done} /> : null}</div>
          </div>
          {l.events.length ? <Entries l={l} orgId={orgId} cur={cur} je={je} onDone={done} /> : null}
          <Card className="mt-4 overflow-x-auto">
            <div className="p-4 pb-0"><CardHeader title="Repayment schedule" description="Installments paid, then those still to pay at the current rate and installment. Interest is charged monthly on the balance at the start of each period." /></div>
            <Table aria-label="Repayment schedule">
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Due</Th>
                  <Th numeric>Opening</Th>
                  <Th numeric>Interest</Th>
                  <Th numeric>Principal</Th>
                  <Th numeric>Installment</Th>
                  <Th numeric>Balance</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {l.paidRows.map((r) => (
                  <Tr key={`p${r.no}`}>
                    <Td className="text-fg-muted">{r.no}</Td>
                    <Td className="whitespace-nowrap">{date(r.date)}</Td>
                    <Td numeric><Money value={r.opening} currency={cur} /></Td>
                    <Td numeric><Money value={r.interest} currency={cur} /></Td>
                    <Td numeric><Money value={r.principal} currency={cur} /></Td>
                    <Td numeric><Money value={r.payment} currency={cur} /></Td>
                    <Td numeric><Money value={r.closing} currency={cur} /></Td>
                    <Td className="text-sm">Paid {je(r.entry)}</Td>
                  </Tr>
                ))}
                {l.rows.map((r) => (
                  <Tr key={r.no}>
                    <Td className="text-fg-muted">{r.no}</Td>
                    <Td className="whitespace-nowrap">{date(r.dueDate)}</Td>
                    <Td numeric><Money value={r.opening} currency={cur} /></Td>
                    <Td numeric><Money value={r.interest} currency={cur} /></Td>
                    <Td numeric><Money value={r.principal} currency={cur} /></Td>
                    <Td numeric><Money value={r.payment} currency={cur} /></Td>
                    <Td numeric><Money value={r.closing} currency={cur} /></Td>
                    <Td>{r.dueDate < today() ? <Badge tone="warning">Overdue</Badge> : <span className="text-sm text-fg-faint">To pay</span>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}

function Actions({ l, orgId, cur, onDone }: { l: LoanDetail; orgId: string; cur: string; onDone: (l: LoanDetail) => void }) {
  const [tab, setTab] = useState<Tab>('repay');
  const accounts = useQuery({ queryKey: ['loan-accounts', orgId], queryFn: () => api<LoanAccounts>(`/v1/orgs/${orgId}/loans/accounts`) });
  return (
    <Card className="p-4" aria-label="Loan actions">
      <div className="mb-4 flex gap-2" role="tablist">
        {([['repay', 'Record installment'], ['prepay', 'Prepay'], ['rate', 'Change rate']] as const).map(([t, label]) => (
          <Button key={t} role="tab" aria-selected={tab === t} size="sm" variant={tab === t ? 'primary' : 'ghost'} onClick={() => setTab(t)}>{label}</Button>
        ))}
      </div>
      {tab === 'repay' ? <Repay key={l.paid.installments} l={l} orgId={orgId} cur={cur} banks={accounts.data?.bank} onDone={onDone} /> : null}
      {tab === 'prepay' ? <Prepay l={l} orgId={orgId} cur={cur} acc={accounts.data} onDone={onDone} /> : null}
      {tab === 'rate' ? <RateChange l={l} orgId={orgId} cur={cur} onDone={onDone} /> : null}
    </Card>
  );
}

const Banks = ({ value, onChange, banks }: { value: string; onChange: (v: string) => void; banks?: { id: string; code: string; name: string }[] }) => (
  <Field label="Paid from">{(p) => <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>{banks?.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
);

function Repay({ l, orgId, cur, banks, onDone }: { l: LoanDetail; orgId: string; cur: string; banks?: { id: string; code: string; name: string }[]; onDone: (l: LoanDetail) => void }) {
  const row = l.next!;
  const [f, setF] = useState({ date: row.dueDate <= today() ? row.dueDate : today(), bank: l.accounts.bank?.id ?? '', split: false, principal: row.principal, interest: row.interest, note: '' });
  const save = useMutation({
    mutationFn: () => api<LoanDetail>(`/v1/orgs/${orgId}/loans/${l.id}/repayments`, { method: 'POST', body: { date: f.date, bankAccountId: f.bank || null, note: f.note || null, ...(f.split ? { principal: f.principal, interest: f.interest } : {}) } }),
    onSuccess: onDone,
  });
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-sm" role="status">
        Installment {row.no}, due {date(row.dueDate)}: principal <Money value={row.principal} currency={cur} /> and interest <Money value={row.interest} currency={cur} />, <span className="font-semibold"><Money value={row.payment} currency={cur} /></span> in all.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Paid on">{(p) => <Input {...p} type="date" value={f.date} max={today()} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} />}</Field>
        <Banks value={f.bank} onChange={(v) => setF((x) => ({ ...x, bank: v }))} banks={banks} />
        <Field label="Note (optional)">{(p) => <Input {...p} value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} maxLength={500} />}</Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.split} onChange={(e) => setF((x) => ({ ...x, split: e.target.checked }))} />
        The lender charged a different split (from the loan statement)
      </label>
      {f.split ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Principal">{(p) => <Input {...p} inputMode="decimal" value={f.principal} onChange={(e) => setF((x) => ({ ...x, principal: e.target.value }))} />}</Field>
          <Field label="Interest">{(p) => <Input {...p} inputMode="decimal" value={f.interest} onChange={(e) => setF((x) => ({ ...x, interest: e.target.value }))} />}</Field>
        </div>
      ) : null}
      <ErrorAlert title="Not recorded" error={save.error} />
      <div><Button type="submit" loading={save.isPending}>Record installment {row.no}</Button></div>
    </form>
  );
}

function Prepay({ l, orgId, cur, acc, onDone }: { l: LoanDetail; orgId: string; cur: string; acc?: LoanAccounts; onDone: (l: LoanDetail) => void }) {
  const [f, setF] = useState({ date: today(), amount: '', mode: 'REDUCE_TENURE' as 'REDUCE_TENURE' | 'REDUCE_INSTALLMENT', charges: '', chargesAccountId: l.accounts.interest?.id ?? '', bank: l.accounts.bank?.id ?? '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const full = f.amount.replace(/,/g, '') !== '' && +f.amount.replace(/,/g, '') === +l.balance;
  const save = useMutation({
    mutationFn: () => api<LoanDetail>(`/v1/orgs/${orgId}/loans/${l.id}/prepayments`, { method: 'POST', body: { date: f.date, amount: f.amount.replace(/,/g, ''), mode: f.mode, charges: f.charges.replace(/,/g, '') || null, chargesAccountId: f.charges ? f.chargesAccountId : null, bankAccountId: f.bank || null, note: f.note || null } }),
    onSuccess: (x) => { setF((y) => ({ ...y, amount: '', charges: '', note: '' })); onDone(x); },
  });
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-sm text-fg-muted">Pays principal early. <Money value={l.balance} currency={cur} /> is owed; prepaying all of it closes the loan.</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Paid on">{(p) => <Input {...p} type="date" value={f.date} max={today()} onChange={set('date')} />}</Field>
        <Field label="Principal prepaid">{(p) => <Input {...p} inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0.00" required />}</Field>
        <Banks value={f.bank} onChange={(v) => setF((x) => ({ ...x, bank: v }))} banks={acc?.bank} />
        <Field label="Prepayment charges (optional)">{(p) => <Input {...p} inputMode="decimal" value={f.charges} onChange={set('charges')} placeholder="0.00" />}</Field>
        <Field label="Charges to">{(p) => <Select {...p} value={f.chargesAccountId} onChange={set('chargesAccountId')}>{acc?.interest.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
        <Field label="Note (optional)">{(p) => <Input {...p} value={f.note} onChange={set('note')} maxLength={500} />}</Field>
      </div>
      {!full ? (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">After the prepayment</legend>
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={f.mode === 'REDUCE_TENURE'} onChange={() => setF((x) => ({ ...x, mode: 'REDUCE_TENURE' }))} /> Keep the installment and finish sooner</label>
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={f.mode === 'REDUCE_INSTALLMENT'} onChange={() => setF((x) => ({ ...x, mode: 'REDUCE_INSTALLMENT' }))} /> Keep the end date and lower the installment</label>
        </fieldset>
      ) : null}
      <ErrorAlert title="Not recorded" error={save.error} />
      <div><Button type="submit" loading={save.isPending}>{full ? 'Repay in full and close' : 'Record prepayment'}</Button></div>
    </form>
  );
}

function RateChange({ l, orgId, onDone }: { l: LoanDetail; orgId: string; cur: string; onDone: (l: LoanDetail) => void }) {
  const [f, setF] = useState({ date: today(), annualRate: '', mode: 'KEEP_INSTALLMENT' as 'KEEP_INSTALLMENT' | 'KEEP_TENURE', note: '' });
  const save = useMutation({
    mutationFn: () => api<LoanDetail>(`/v1/orgs/${orgId}/loans/${l.id}/rate-changes`, { method: 'POST', body: { date: f.date, annualRate: f.annualRate, mode: f.mode, note: f.note || null } }),
    onSuccess: (x) => { setF((y) => ({ ...y, annualRate: '', note: '' })); onDone(x); },
  });
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-sm text-fg-muted">A floating rate reset by the lender. The new rate applies from the next installment; nothing is posted.</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={f.date} max={today()} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} />}</Field>
        <Field label="New rate (% a year)" hint={`Now ${l.annualRate}%`}>{(p) => <Input {...p} inputMode="decimal" value={f.annualRate} onChange={(e) => setF((x) => ({ ...x, annualRate: e.target.value }))} required />}</Field>
        <Field label="Note (optional)">{(p) => <Input {...p} value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} maxLength={500} />}</Field>
      </div>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Then</legend>
        <label className="flex items-center gap-2"><input type="radio" name="rate-mode" checked={f.mode === 'KEEP_INSTALLMENT'} onChange={() => setF((x) => ({ ...x, mode: 'KEEP_INSTALLMENT' }))} /> Keep the installment; the term changes</label>
        <label className="flex items-center gap-2"><input type="radio" name="rate-mode" checked={f.mode === 'KEEP_TENURE'} onChange={() => setF((x) => ({ ...x, mode: 'KEEP_TENURE' }))} /> Keep the end date; the installment changes</label>
      </fieldset>
      <ErrorAlert title="Rate not changed" error={save.error} />
      <div><Button type="submit" loading={save.isPending}>Change rate</Button></div>
    </form>
  );
}

const WHAT = (e: LoanEvent) =>
  e.kind === 'REPAYMENT'
    ? `Installment ${e.installmentNo}`
    : e.kind === 'PREPAYMENT'
      ? e.balanceAfter === '0.00' || +e.balanceAfter === 0
        ? 'Repaid in full'
        : `Prepayment (${e.mode === 'REDUCE_TENURE' ? 'finish sooner' : 'lower installment'})`
      : `Rate ${e.rateBefore}% to ${e.rateAfter}% (${e.mode === 'KEEP_INSTALLMENT' ? 'term changes' : 'installment changes'})`;

function Entries({ l, orgId, cur, je, onDone }: { l: LoanDetail; orgId: string; cur: string; je: (e: EntryRef) => React.ReactNode; onDone: (l: LoanDetail) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const reverse = useMutation({ mutationFn: (id: string) => api<LoanDetail>(`/v1/orgs/${orgId}/loans/${l.id}/events/${id}/reverse`, { method: 'POST' }), onSuccess: (x) => { setConfirm(null); onDone(x); } });
  return (
    <Card className="mt-4 overflow-x-auto">
      <div className="p-4 pb-0"><CardHeader title="Entries" description="Installments, prepayments and rate changes in order. Only the latest can be reversed." /></div>
      <Table aria-label="Loan entries">
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Entry</Th>
            <Th numeric>Principal</Th>
            <Th numeric>Interest and charges</Th>
            <Th numeric>Owed after</Th>
            <Th>Journal</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {[...l.events].reverse().map((e) => (
            <Tr key={e.id}>
              <Td className="whitespace-nowrap">{date(e.date)}</Td>
              <Td>
                {WHAT(e)}
                <span className="block text-xs text-fg-faint">{[e.kind !== 'RATE_CHANGE' && e.installmentAfter !== e.installmentBefore ? `Installment now ${e.installmentAfter}` : null, e.note, e.createdBy].filter(Boolean).join(' · ')}</span>
              </Td>
              <Td numeric>{e.kind === 'RATE_CHANGE' ? '—' : <Money value={e.principal} currency={cur} />}</Td>
              <Td numeric>{e.kind === 'RATE_CHANGE' ? '—' : <Money value={(+e.interest + +e.charges).toFixed(2)} currency={cur} />}</Td>
              <Td numeric><Money value={e.balanceAfter} currency={cur} /></Td>
              <Td className="whitespace-nowrap text-sm">{je(e.entry)}{e.reversal?.entry ? <> · reversed by {je(e.reversal.entry)}</> : null}</Td>
              <Td className="whitespace-nowrap">
                {e.status === 'REVERSED' ? (
                  <Badge>Reversed by {e.reversal?.by}</Badge>
                ) : l.can.manage && e.canReverse ? (
                  confirm === e.id ? (
                    <span className="flex gap-1">
                      <Button size="sm" variant="danger" loading={reverse.isPending} onClick={() => reverse.mutate(e.id)}>Reverse {WHAT(e).toLowerCase()}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(e.id)}>Reverse…</Button>
                  )
                ) : null}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {reverse.error ? <div className="p-4"><ErrorAlert title="Not reversed" error={reverse.error} /></div> : null}
    </Card>
  );
}
