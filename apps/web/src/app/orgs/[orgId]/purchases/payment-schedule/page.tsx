'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { WEEKDAYS, type PaymentSchedule, type ScheduledBill } from '@/lib/payment-schedule';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';
const AMOUNT = /^\d{0,18}(\.\d{0,6})?$/;
const PAY_DAY_KEY = 't2t.payWeekday';

function readPayDay(): string {
  try {
    return localStorage.getItem(PAY_DAY_KEY) ?? '';
  } catch {
    return '';
  }
}

function Schedule() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [payDay, setPayDay] = useState('');
  useEffect(() => setPayDay(readPayDay()), []);
  const base = `/v1/orgs/${orgId}/purchases/payment-schedule`;
  const q = useQuery({ queryKey: ['payment-schedule', orgId, payDay], queryFn: () => api<PaymentSchedule>(`${base}${payDay ? `?payWeekday=${payDay}` : ''}`) });
  const [editing, setEditing] = useState<ScheduledBill | null>(null);
  const [payDate, setPayDate] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [batchUpTo, setBatchUpTo] = useState('');
  const open = (b: ScheduledBill) => {
    plan.reset();
    setEditing(b);
    setPayDate(b.plan?.payDate ?? b.suggested);
    setAmount(b.plan?.partial ? b.plan.amount : '');
    setNote(b.plan?.note ?? '');
  };
  // Opened from a bill's Plan payment… button.
  const wanted = params.get('plan');
  const opened = useRef(false);
  useEffect(() => {
    if (!wanted || !q.data || opened.current) return;
    opened.current = true;
    const b = q.data.bills.find((x) => x.id === wanted);
    if (b) open(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, q.data]);
  useEffect(() => {
    if (q.data && !batchUpTo) setBatchUpTo(addDays(q.data.today, 6));
  }, [q.data, batchUpTo]);
  const refresh = (s: PaymentSchedule) => qc.setQueryData(['payment-schedule', orgId, payDay], s);
  const plan = useMutation({
    mutationFn: () => api<PaymentSchedule>(`${base}/bills/${editing!.id}`, { method: 'PUT', body: { payDate, amount: amount || null, note: note || null } }),
    onSuccess: (s) => {
      refresh(s);
      setEditing(null);
    },
  });
  const unplan = useMutation({
    mutationFn: (id: string) => api<PaymentSchedule>(`${base}/bills/${id}`, { method: 'DELETE' }),
    onSuccess: (s) => {
      refresh(s);
      setEditing(null);
    },
  });
  const auto = useMutation({
    mutationFn: () => api<{ planned: number; schedule: PaymentSchedule }>(`${base}/auto`, { method: 'POST', body: { payWeekday: payDay === '' ? null : Number(payDay) } }),
    onSuccess: (r) => refresh(r.schedule),
  });
  const choosePayDay = (v: string) => {
    setPayDay(v);
    try {
      if (v) localStorage.setItem(PAY_DAY_KEY, v);
      else localStorage.removeItem(PAY_DAY_KEY);
    } catch {
      /* the choice just isn't remembered */
    }
  };

  if (!org) return null;
  const s = q.data;
  const c = org.functionalCurrency;
  const inBatchCount = s ? s.bills.filter((b) => b.plan && b.plan.payDate <= batchUpTo && !b.inBatch).length : 0;
  return (
    <>
      <PageHeader
        title="Payment schedule"
        description="When each open bill will be paid, and what that leaves in the bank week by week. Plan a date (and an amount, to pay part) for each bill, then prepare a payment batch from the bills planned up to a date. Planning moves no money."
        actions={
          s?.can.plan ? (
            <Button variant="secondary" loading={auto.isPending} disabled={!s.totals.unplanned} onClick={() => auto.mutate()}>
              Plan the rest{payDay ? ` on ${WEEKDAYS[Number(payDay)]}s` : ' on their due dates'}
            </Button>
          ) : null
        }
      />
      <ErrorAlert title="Could not load the schedule" error={q.error} />
      <ErrorAlert title="That did not work" error={auto.error ?? unplan.error} />
      {auto.data ? (
        <Alert tone="positive" title={auto.data.planned ? `${auto.data.planned} ${auto.data.planned === 1 ? 'bill' : 'bills'} planned` : 'Every open bill already has a plan'}>
          {auto.data.planned ? 'Each one is planned for its suggested date; change any of them below.' : null}
        </Alert>
      ) : null}
      {s ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Stat label="Cash in bank" value={<Money value={s.cash.total} currency={c} />} tone="accent" sub={`${s.cash.accounts.length} bank ${s.cash.accounts.length === 1 ? 'account' : 'accounts'}, from the ledger`} />
            <Stat label="Open bills" value={<Money value={s.totals.open} currency={c} />} tone="violet" sub={`${s.bills.length} ${s.bills.length === 1 ? 'bill' : 'bills'} with something to pay`} />
            <Stat label="Planned" value={<Money value={s.totals.planned} currency={c} />} tone="positive" sub={`${s.bills.length - s.totals.unplanned} planned`} />
            <Stat label="Not planned" value={String(s.totals.unplanned)} tone={s.totals.overdueUnplanned ? 'negative' : s.totals.unplanned ? 'warning' : 'positive'} sub={`${s.totals.overdueUnplanned} of them overdue`} />
            <Stat label="Planned late" value={String(s.totals.late + s.totals.missed)} tone={s.totals.late + s.totals.missed ? 'warning' : 'positive'} sub="After the due date, or a planned date that has passed" />
          </div>

          <Card>
            <CardHeader title="Cash by week" description={`Planned payments each week, Monday to Sunday, and the bank balance after them. Receipts are not included, so a short week shows where money must come in or a payment move. Plans dated before this week count in this week.`} />
            <Table aria-label="Cash by week">
              <thead>
                <tr><Th>Week of</Th><Th numeric>Payments</Th><Th numeric>Planned</Th><Th numeric>Cash after</Th><Th /></tr>
              </thead>
              <tbody>
                {s.weeks.map((w) => (
                  <Tr key={w.week}>
                    <Td>{date(w.week)}</Td>
                    <Td numeric>{w.payments}</Td>
                    <Td numeric><Money value={w.amount} currency={c} /></Td>
                    <Td numeric className={w.short ? 'text-negative' : ''}><Money value={w.balanceAfter} currency={c} /></Td>
                    <Td>{w.short ? <Badge tone="negative">Short</Badge> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card className="mt-6">
            <CardHeader title="Bills to pay" description="Every posted bill with something left to pay: planned ones first by date, then the rest by due date. The suggested date is the due date, or your pay day before it." />
            <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-3">
              <label className={label}>
                We pay on
                <Select className="w-44" value={payDay} onChange={(e) => choosePayDay(e.target.value)}>
                  <option value="">Any day (the due date)</option>
                  {WEEKDAYS.map((d, i) => <option key={d} value={String(i)}>{d}s</option>)}
                </Select>
              </label>
              {s.can.prepareBatch ? (
                <div className="ml-auto flex items-end gap-2">
                  <label className={label}>
                    Bills planned up to
                    <Input type="date" value={batchUpTo} min={s.today} onChange={(e) => setBatchUpTo(e.target.value)} />
                  </label>
                  {inBatchCount ? (
                    <Link href={`/orgs/${orgId}/purchases/payment-batches/new?plannedUpTo=${batchUpTo}`}><Button>Prepare batch ({inBatchCount})</Button></Link>
                  ) : (
                    <Button disabled>Prepare batch</Button>
                  )}
                </div>
              ) : null}
            </div>
            {s.bills.length === 0 ? (
              <EmptyState title="Nothing to pay">Every posted bill is paid.</EmptyState>
            ) : (
              <Table aria-label="Bills to pay">
                <thead>
                  <tr><Th>Bill</Th><Th>Vendor</Th><Th>Due</Th><Th numeric>Left to pay</Th><Th>Planned</Th><Th numeric>To pay</Th><Th /></tr>
                </thead>
                <tbody>
                  {s.bills.map((b) => (
                    <Tr key={b.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${b.id}`}>{b.number}</Link>
                        {b.inBatch ? <span className="block text-xs text-fg-muted">In {b.inBatch}</span> : null}
                      </Td>
                      <Td>{b.vendor.name}{b.bank && !b.bank.verified ? <span className="block text-xs text-warning">Bank details not verified</span> : !b.bank ? <span className="block text-xs text-fg-muted">No bank details</span> : null}</Td>
                      <Td>{date(b.dueDate)}{b.overdue ? <Badge tone="negative" className="ml-2">Overdue</Badge> : null}</Td>
                      <Td numeric><Money value={b.due} currency={c} /></Td>
                      <Td>
                        {b.plan ? (
                          <>
                            {date(b.plan.payDate)}{' '}
                            {b.plan.missed ? <Badge tone="warning">Date passed</Badge> : b.plan.late ? <Badge tone="warning">After due date</Badge> : <Badge tone="positive">On time</Badge>}
                            {b.plan.note ? <span className="block text-xs text-fg-muted">{b.plan.note}</span> : null}
                          </>
                        ) : (
                          <span className="text-fg-muted">Not planned · suggested {date(b.suggested)}</span>
                        )}
                      </Td>
                      <Td numeric>{b.plan ? <><Money value={b.plan.amount} currency={c} />{b.plan.partial ? <span className="block text-xs text-fg-muted">part</span> : null}</> : '—'}</Td>
                      <Td>{s.can.plan ? <Button size="sm" variant={b.plan ? 'ghost' : 'secondary'} onClick={() => open(b)}>{b.plan ? 'Change…' : 'Plan…'}</Button> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing ? `Plan payment of ${editing.number}` : ''} description={editing ? `${editing.vendor.name}, due ${date(editing.dueDate)}, ${editing.due} left to pay.` : ''}>
        {editing ? (
          <div className="flex flex-col gap-4">
            <label className={label}>
              Pay on
              <Input type="date" value={payDate} min={s?.today} onChange={(e) => setPayDate(e.target.value)} />
              {payDate > editing.dueDate ? <span className="normal-case tracking-normal text-warning">After the due date ({date(editing.dueDate)}).</span> : null}
            </label>
            <label className={label}>
              Amount (leave empty to pay all that is left)
              <Input inputMode="decimal" className="num" placeholder={editing.due} value={amount} onChange={(e) => AMOUNT.test(e.target.value) && setAmount(e.target.value)} />
            </label>
            <label className={label}>
              Note
              <Input maxLength={300} value={note} placeholder="Optional, e.g. agreed with the vendor" onChange={(e) => setNote(e.target.value)} />
            </label>
            <ErrorAlert title="The plan was not saved" error={plan.error} />
            <div className="flex flex-wrap justify-end gap-2">
              {editing.plan ? <Button variant="ghost" loading={unplan.isPending} onClick={() => unplan.mutate(editing.id)}>Remove plan</Button> : null}
              <Button loading={plan.isPending} disabled={!payDate} onClick={() => plan.mutate()}>Save plan</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

export default function PaymentSchedulePage() {
  return (
    <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
      <Schedule />
    </Suspense>
  );
}
