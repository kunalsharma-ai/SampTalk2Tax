'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { COMPOUNDING, type Choice, type DepositAccounts, type DepositDetail, type DepositEvent } from '@/lib/deposits';
import { date } from '@/lib/format';
import { today } from '@/lib/loans';
import { useOrg } from '@/lib/org';

const acct = (a: Choice) => `${a.code} ${a.name}`;
const KIND: Record<DepositEvent['kind'], string> = { PLACED: 'Placed', ACCRUED: 'Interest accrued', CLOSED: 'Closed' };
const minDate = (a: string, b: string) => (a < b ? a : b);

export default function DepositPage() {
  const { org, orgId } = useOrg();
  const { depositId } = useParams<{ depositId: string }>();
  const qc = useQueryClient();
  const key = ['deposit', orgId, depositId];
  const q = useQuery({ queryKey: key, queryFn: () => api<DepositDetail>(`/v1/orgs/${orgId}/deposits/${depositId}`) });
  const done = (d: DepositDetail) => {
    qc.setQueryData(key, d);
    void qc.invalidateQueries({ queryKey: ['deposits', orgId] });
  };
  if (!org) return null;
  const d = q.data;
  const cur = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title={d ? `${d.number} ${d.name}` : 'Deposit'}
        description={d ? [d.institution, d.institutionRef ? `No. ${d.institutionRef}` : null, `${d.annualRate}% a year`, COMPOUNDING[d.compounding]].filter(Boolean).join(' · ') : undefined}
        actions={<Link href={`/orgs/${orgId}/deposits`}><Button variant="secondary">All deposits</Button></Link>}
      />
      <ErrorAlert title="Could not load the deposit" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Principal" value={<Money value={d.principal} currency={cur} />} tone="accent" sub={`${date(d.startDate)} to ${date(d.maturityDate)}`} />
            <Stat label="Earned to date" value={<Money value={d.earnedToDate} currency={cur} />} tone="positive" sub={d.status === 'OPEN' ? <>Not accrued yet <Money value={d.notAccrued} currency={cur} /></> : 'Closed'} />
            <Stat label="Accrued in the books" value={<Money value={d.accrued} currency={cur} />} sub={d.accruedTo ? `To ${date(d.accruedTo)}` : 'Nothing accrued yet'} />
            <Stat label="At maturity" value={<Money value={d.maturityValue} currency={cur} />} tone="violet" sub={<>Interest <Money value={d.maturityInterest} currency={cur} /></>} />
          </div>
          {d.status === 'OPEN' && d.daysToMaturity < 0 ? (
            <div className="mb-4"><Alert tone="warning" title="This deposit has matured">Record what the bank paid to close it, or place a new deposit if it was renewed.</Alert></div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="p-4">
              <CardHeader title="Terms and accounts" />
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-fg-muted">Status</dt>
                <dd>{d.status === 'OPEN' ? <Badge tone="positive">Open</Badge> : <Badge>Closed</Badge>}</dd>
                <dt className="text-fg-muted">Interest rate</dt>
                <dd>{d.annualRate}% a year</dd>
                <dt className="text-fg-muted">Compounding</dt>
                <dd>{COMPOUNDING[d.compounding]}</dd>
                <dt className="text-fg-muted">Paid from</dt>
                <dd>{acct(d.accounts.bank)}</dd>
                <dt className="text-fg-muted">Deposit account</dt>
                <dd>{acct(d.accounts.deposit)}</dd>
                <dt className="text-fg-muted">Interest accrued</dt>
                <dd>{acct(d.accounts.accruedInterest)}</dd>
                <dt className="text-fg-muted">Interest income</dt>
                <dd>{acct(d.accounts.interestIncome)}</dd>
              </dl>
            </Card>
            <div className="xl:col-span-2">{d.can.manage && d.status === 'OPEN' ? <Actions d={d} orgId={orgId} cur={cur} onDone={done} /> : null}</div>
          </div>
          <Entries key={d.events.find((e) => e.canReverse)?.id ?? 'none'} d={d} orgId={orgId} cur={cur} onDone={done} />
        </>
      ) : null}
    </>
  );
}

function Actions({ d, orgId, cur, onDone }: { d: DepositDetail; orgId: string; cur: string; onDone: (d: DepositDetail) => void }) {
  const [tab, setTab] = useState<'accrue' | 'close'>(d.daysToMaturity < 0 ? 'close' : 'accrue');
  return (
    <Card className="p-4" aria-label="Deposit actions">
      <div className="mb-4 flex gap-2" role="tablist">
        {([['accrue', 'Accrue interest'], ['close', 'Close deposit']] as const).map(([t, label]) => (
          <Button key={t} role="tab" aria-selected={tab === t} size="sm" variant={tab === t ? 'primary' : 'ghost'} onClick={() => setTab(t)}>{label}</Button>
        ))}
      </div>
      {tab === 'accrue' ? <Accrue key={d.accrued} d={d} orgId={orgId} cur={cur} onDone={onDone} /> : <Close d={d} orgId={orgId} cur={cur} onDone={onDone} />}
    </Card>
  );
}

function Accrue({ d, orgId, cur, onDone }: { d: DepositDetail; orgId: string; cur: string; onDone: (d: DepositDetail) => void }) {
  const [to, setTo] = useState(minDate(today(), d.maturityDate));
  const m = useMutation({ mutationFn: () => api<DepositDetail>(`/v1/orgs/${orgId}/deposits/${d.id}/accrue`, { method: 'POST', body: { date: to } }), onSuccess: onDone });
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <p className="text-sm text-fg-muted">
        Posts the interest earned since {d.accruedTo ? date(d.accruedTo) : 'the start date'}: Dr {acct(d.accounts.accruedInterest)}, Cr {acct(d.accounts.interestIncome)}. Earned and not accrued as of today: <Money value={d.notAccrued} currency={cur} />.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Accrue to">{(p) => <Input {...p} type="date" value={to} min={d.accruedTo ?? d.startDate} max={minDate(today(), d.maturityDate)} onChange={(e) => setTo(e.target.value)} required />}</Field>
        <Button type="submit" loading={m.isPending}>Accrue</Button>
      </div>
      <ErrorAlert title="Not accrued" error={m.error} />
    </form>
  );
}

function Close({ d, orgId, cur, onDone }: { d: DepositDetail; orgId: string; cur: string; onDone: (d: DepositDetail) => void }) {
  const accounts = useQuery({ queryKey: ['deposit-accounts', orgId], queryFn: () => api<DepositAccounts>(`/v1/orgs/${orgId}/deposits/accounts`) });
  const [f, setF] = useState({ date: minDate(today(), d.maturityDate), received: d.daysToMaturity < 0 ? d.maturityValue : '', tds: '0', tdsAccountId: '', bankAccountId: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const tdsList = (accounts.data?.tds ?? []).filter((a) => a.id !== d.accounts.deposit.id && a.id !== d.accounts.accruedInterest.id);
  const tdsId = f.tdsAccountId || tdsList.find((a) => /tds|tax deducted/i.test(a.name))?.id || tdsList[0]?.id || '';
  const bankId = f.bankAccountId || d.accounts.bank.id;
  const early = f.date < d.maturityDate;
  const num = (v: string) => {
    try {
      return new D(v.replace(/,/g, '') || '0');
    } catch {
      return new D(0);
    }
  };
  const received = num(f.received);
  const tds = num(f.tds);
  const m = useMutation({
    mutationFn: () => api<DepositDetail>(`/v1/orgs/${orgId}/deposits/${d.id}/close`, { method: 'POST', body: { date: f.date, received: f.received.replace(/,/g, ''), tds: f.tds.replace(/,/g, '') || '0', tdsAccountId: tds.gt(0) ? tdsId : null, bankAccountId: bankId, note: f.note || null } }),
    onSuccess: onDone,
  });
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <p className="text-sm text-fg-muted">Enter what the bank actually paid and the tax it deducted. The interest is what was paid plus the tax less the principal; what was accrued is cleared and the rest is booked as income now (or taken back, after a penalty for closing early).</p>
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Closed on">{(p) => <Input {...p} type="date" value={f.date} max={today()} onChange={set('date')} required />}</Field>
        <Field label="Amount received" hint={d.daysToMaturity < 0 ? 'Filled in with the maturity value' : undefined}>{(p) => <Input {...p} inputMode="decimal" value={f.received} onChange={set('received')} placeholder="0.00" required />}</Field>
        <Field label="Tax deducted (TDS)">{(p) => <Input {...p} inputMode="decimal" value={f.tds} onChange={set('tds')} placeholder="0.00" />}</Field>
        <Field label="Received into">{(p) => <Select {...p} value={bankId} onChange={set('bankAccountId')}>{(accounts.data?.bank ?? [d.accounts.bank]).map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
        {tds.gt(0) ? <Field label="Claim the tax in">{(p) => <Select {...p} value={tdsId} onChange={set('tdsAccountId')}>{tdsList.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field> : null}
        <Field label="Note (optional)">{(p) => <Input {...p} value={f.note} onChange={set('note')} maxLength={500} />}</Field>
      </section>
      {received.gt(0) ? (
        <p className="text-sm">
          Interest {early ? 'on closing early' : 'at maturity'}: <Money value={received.plus(tds).minus(d.principal).toFixed(2)} currency={cur} /> (accrued so far <Money value={d.accrued} currency={cur} />).
        </p>
      ) : null}
      <ErrorAlert title="Not closed" error={m.error} />
      <div><Button type="submit" loading={m.isPending} disabled={!f.received}>{early ? 'Close early' : 'Record maturity'}</Button></div>
    </form>
  );
}

function Entries({ d, orgId, cur, onDone }: { d: DepositDetail; orgId: string; cur: string; onDone: (d: DepositDetail) => void }) {
  const [reason, setReason] = useState('');
  const latest = d.events.find((e) => e.canReverse);
  const [on, setOn] = useState(today());
  const m = useMutation({ mutationFn: () => api<DepositDetail>(`/v1/orgs/${orgId}/deposits/${d.id}/reverse`, { method: 'POST', body: { date: on, reason } }), onSuccess: (x) => { setReason(''); onDone(x); } });
  const je = (id: string | null) => (id ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${id}`}>Entry</Link> : null);
  return (
    <Card className="mt-4 overflow-x-auto">
      <div className="p-4 pb-0"><CardHeader title="Deposit postings" description="Every journal posted for this deposit. Only the latest accrual or the closing can be reversed." /></div>
      <Table aria-label="Deposit postings">
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>What</Th>
            <Th numeric>Amount</Th>
            <Th>Details</Th>
            <Th>Journal</Th>
          </tr>
        </thead>
        <tbody>
          {d.events.map((e) => (
            <Tr key={e.id}>
              <Td className="whitespace-nowrap">{date(e.date)}</Td>
              <Td>
                {KIND[e.kind]}
                {e.early ? ' early' : ''} {e.reversed ? <Badge tone="warning">Reversed</Badge> : null}
              </Td>
              <Td numeric><Money value={e.amount} currency={cur} /></Td>
              <Td className="text-sm text-fg-muted">
                {e.kind === 'CLOSED' ? <>Received <Money value={e.received ?? '0'} currency={cur} />, tax deducted <Money value={e.tds ?? '0'} currency={cur} />, interest <Money value={e.interest ?? '0'} currency={cur} /></> : null}
                {e.note ? <span className="block">{e.note}</span> : null}
                {e.by ? <span className="block text-xs text-fg-faint">By {e.by}</span> : null}
              </Td>
              <Td className="text-sm">{je(e.entryId)}{e.reversalEntryId ? <> · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.reversalEntryId}`}>Reversal</Link></> : null}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {d.can.manage && latest ? (
        <form className="flex flex-wrap items-end gap-3 border-t border-line p-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label={`Reverse the latest posting (${KIND[latest.kind].toLowerCase()} on ${date(latest.date)})`}>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is being reversed" maxLength={500} required />}</Field>
          <Field label="Reverse on">{(p) => <Input {...p} type="date" value={on} min={latest.date} max={today()} onChange={(e) => setOn(e.target.value)} required />}</Field>
          <Button type="submit" variant="secondary" loading={m.isPending}>Reverse</Button>
          <div className="basis-full"><ErrorAlert title="Not reversed" error={m.error} /></div>
        </form>
      ) : null}
    </Card>
  );
}
