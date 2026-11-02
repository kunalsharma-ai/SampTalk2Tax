'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { acct, KIND, METHOD, shortMonth, STATUS, today, type DeferralAccounts, type EntryRef, type ScheduleDetail } from '@/lib/deferrals';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function SchedulePage() {
  const { org, orgId } = useOrg();
  const { scheduleId } = useParams<{ scheduleId: string }>();
  const qc = useQueryClient();
  const key = ['deferral', orgId, scheduleId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ScheduleDetail>(`/v1/orgs/${orgId}/deferrals/${scheduleId}`) });
  if (!org) return null;
  const s = q.data;
  const cur = org.functionalCurrency;
  const je = (e: EntryRef, label = 'Journal') => (e ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>{label} #{e.entryNumber}</Link> : null);
  const prepaid = s?.kind === 'PREPAID_EXPENSE';
  return (
    <>
      <PageHeader
        title={s ? `${s.reference} ${s.name}` : 'Schedule'}
        description={s ? [KIND[s.kind], s.counterparty].filter(Boolean).join(' · ') : undefined}
        actions={s?.can.manage && s.status !== 'ENDED' ? <Link href={`/orgs/${orgId}/deferrals/${scheduleId}/edit`}><Button variant="secondary">Change…</Button></Link> : undefined}
      />
      <ErrorAlert title="Could not load the schedule" error={q.error} />
      {s ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label={prepaid ? 'Paid in advance' : 'Received in advance'} value={<Money value={s.amount} currency={cur} />} sub={`${date(s.startDate)} to ${date(s.endDate)}`} />
            <Stat label={prepaid ? 'Expensed so far' : 'Earned so far'} value={<Money value={s.released} currency={cur} />} tone="accent" />
            <Stat label="Still to release" value={<Money value={s.remaining} currency={cur} />} tone={s.status === 'ACTIVE' ? 'positive' : 'neutral'} sub={`In ${acct(s.accounts.balance)}`} />
            <Stat label="Status" value={<Badge tone={s.status === 'ACTIVE' ? 'accent' : s.status === 'COMPLETED' ? 'positive' : 'neutral'}>{STATUS[s.status]}</Badge>} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="p-4 xl:col-span-1">
              <CardHeader title="Terms" />
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-fg-muted">Covers</dt>
                <dd>{s.months} months from {date(s.startDate)}</dd>
                <dt className="text-fg-muted">Release</dt>
                <dd>{METHOD[s.method]}</dd>
                <dt className="text-fg-muted">{prepaid ? 'Prepaid account' : 'Deferred revenue account'}</dt>
                <dd>{acct(s.accounts.balance)}</dd>
                <dt className="text-fg-muted">Released to</dt>
                <dd>{acct(s.accounts.pnl)}</dd>
                <dt className="text-fg-muted">{prepaid ? 'Payment' : 'Receipt'}</dt>
                <dd>{je(s.initialEntry) ?? 'Not posted here'}</dd>
                <dt className="text-fg-muted">Added by</dt>
                <dd>{s.createdBy}</dd>
              </dl>
            </Card>
            <Card className="overflow-x-auto xl:col-span-2">
              <div className="p-4 pb-0"><CardHeader title="Release schedule" description="Each month's share. A posted month keeps the amount posted; the next month catches up any difference." /></div>
              <Table aria-label="Release schedule">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th numeric>Release</Th>
                    <Th numeric>Released to date</Th>
                    <Th numeric>Left</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.schedule.map((r) => {
                    const p = s.postings.find((x) => x.month === r.month && x.runStatus === 'POSTED');
                    return (
                      <Tr key={r.month}>
                        <Td>{shortMonth(r.month)}</Td>
                        <Td numeric><Money value={r.amount} currency={cur} /></Td>
                        <Td numeric><Money value={r.released} currency={cur} /></Td>
                        <Td numeric><Money value={r.remaining} currency={cur} /></Td>
                        <Td>{r.posted ? <span className="text-sm">Posted {p ? <>in {je(p.entry)}{p.runMonth !== r.month ? ` (${shortMonth(p.runMonth)} run)` : ''}</> : null}</span> : <span className="text-sm text-fg-faint">To come</span>}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          </div>
          {s.end ? (
            <Card className="mt-4 p-4" aria-label="Ended early">
              <CardHeader title={`Ended early on ${date(s.end.date)}`} />
              <p className="mt-2 text-sm">
                <Money value={s.end.amount} currency={cur} /> released in one go · by {s.end.by} {s.end.entry ? <>· {je(s.end.entry)}</> : null}
                {s.end.note ? <span className="block text-fg-muted">{s.end.note}</span> : null}
              </p>
            </Card>
          ) : s.can.manage && s.status === 'ACTIVE' ? (
            <EndCard s={s} orgId={orgId} cur={cur} onDone={(x) => { qc.setQueryData(key, x); void qc.invalidateQueries({ queryKey: ['deferrals', orgId] }); }} />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function EndCard({ s, orgId, cur, onDone }: { s: ScheduleDetail; orgId: string; cur: string; onDone: (s: ScheduleDetail) => void }) {
  const [open, setOpen] = useState(false);
  const accounts = useQuery({ queryKey: ['deferral-accounts', orgId], queryFn: () => api<DeferralAccounts>(`/v1/orgs/${orgId}/deferrals/accounts`), enabled: open });
  const [f, setF] = useState({ date: today(), accountId: '', note: '' });
  const prepaid = s.kind === 'PREPAID_EXPENSE';
  const choices = (accounts.data?.any ?? []).filter((a) => a.id !== s.accounts.balance?.id);
  const target = f.accountId || s.accounts.pnl?.id || '';
  const end = useMutation({
    mutationFn: () => api<ScheduleDetail>(`/v1/orgs/${orgId}/deferrals/${s.id}/end`, { method: 'POST', body: { date: f.date, accountId: target, note: f.note || null } }),
    onSuccess: (x) => { setOpen(false); onDone(x); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Card className="mt-4 p-4" aria-label="End this schedule early">
      <CardHeader
        title={prepaid ? 'Cancelled or used up early?' : 'Contract cancelled or delivered early?'}
        description={`Ending a schedule early releases what is left in one entry on the end date: to ${prepaid ? 'the expense account' : 'the revenue account'}, or to another account such as the bank for a refund. Releases must be posted through the month before the end.`}
        actions={!open ? <Button variant="secondary" onClick={() => setOpen(true)}>End early…</Button> : undefined}
      />
      {open ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Ends on">{(p) => <Input {...p} type="date" value={f.date} max={today()} onChange={set('date')} />}</Field>
            <Field label="What is left goes to" hint={prepaid ? 'Expense, or a receivable or bank for a refund' : 'Revenue, or the bank for a refund'}>
              {(p) => (
                <Select {...p} value={target} onChange={set('accountId')}>
                  {choices.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Note (optional)">{(p) => <Input {...p} value={f.note} onChange={set('note')} maxLength={500} />}</Field>
          <p className="text-sm" role="status">
            <Money value={s.remaining} currency={cur} /> is left in {acct(s.accounts.balance)}; it is released in one entry on the end date.
          </p>
          <ErrorAlert title="Not ended" error={end.error} />
          <div className="flex gap-2">
            <Button variant="danger" loading={end.isPending} disabled={!target} onClick={() => end.mutate()}>End {s.reference}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
