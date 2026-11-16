'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ForecastChart } from '@/components/cash-flow/forecast-chart';
import { Money } from '@/components/money';
import { DateInput } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { BASIS, FREQUENCY, HORIZONS, type CashForecast, type Frequency, type OpenItem, type PlannedItem, type SavedForecast, type SavedSummary } from '@/lib/cashflow';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
/** "10 days late", "17 days early", "on the due date". */
const timing = (days: number) => (days === 0 ? 'on the due date' : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'late' : 'early'}`);

export default function CashFlowPage() {
  return (
    <Suspense>
      <CashFlow />
    </Suspense>
  );
}

function CashFlow() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const horizon = Number(params.get('days') ?? 90);
  const asOfParam = params.get('asOf');
  const q = useQuery({
    queryKey: ['cash-forecast', orgId, horizon, asOfParam],
    queryFn: () => api<CashForecast>(`/v1/orgs/${orgId}/cash-flow/forecast?horizonDays=${horizon}${asOfParam ? `&asOf=${asOfParam}` : ''}`),
  });
  const saved = useQuery({ queryKey: ['cash-forecasts', orgId], queryFn: () => api<SavedSummary[]>(`/v1/orgs/${orgId}/cash-flow/forecasts`) });
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => api<SavedForecast>(`/v1/orgs/${orgId}/cash-flow/forecasts`, { method: 'POST', body: { horizonDays: horizon, ...(asOfParam ? { asOf: asOfParam } : {}), note: note.trim() || null } }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['cash-forecasts', orgId] });
      router.push(`/orgs/${orgId}/planning/cash-flow/forecasts/${s.id}`);
    },
  });
  if (!org) return null;
  const canManage = can(org.role, 'budgets.manage');
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) if (v === null) next.delete(k); else next.set(k, v);
    router.replace(`/orgs/${orgId}/planning/cash-flow?${next.toString()}`);
  };
  const f = q.data;
  const c = f?.currency ?? org.functionalCurrency;
  const tone = (amt: string) => (f && Number(f.minimumBalance) > 0 && Number(amt) < Number(f.minimumBalance) ? 'negative' : 'neutral');

  return (
    <>
      <PageHeader
        title="Cash-flow forecast"
        description="Daily cash and bank balance ahead: open invoices and bills at the dates customers and vendors usually pay, plus the planned receipts and payments below. The range comes from how early or late each contact has paid in the last year."
        actions={f ? <DateInput label="As of" value={f.asOf} onChange={(x) => set({ asOf: f && x === f.today ? null : x })} /> : null}
      />
      <ErrorAlert title="Could not load the forecast" error={q.error} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Horizon">
          {HORIZONS.map((h) => (
            <Button key={h} size="sm" variant={h === horizon ? 'secondary' : 'ghost'} aria-pressed={h === horizon} onClick={() => set({ days: String(h) })}>
              {h} days
            </Button>
          ))}
        </div>
        {f?.isBacktest ? (
          <span className="flex items-center gap-2 text-sm">
            <Badge tone="accent">Backtest</Badge>
            <span className="text-fg-muted">The books as they stood on {date(f.asOf)}.</span>
            <Button size="sm" variant="ghost" onClick={() => set({ asOf: null })}>Back to today</Button>
          </span>
        ) : null}
        {canManage && f ? (
          <span className="ml-auto flex items-center gap-2">
            <Input aria-label="Note for the saved forecast" placeholder="Note (optional)" className="w-56" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            <Button loading={save.isPending} onClick={() => save.mutate()}>{f.isBacktest ? 'Save backtest' : 'Save forecast'}</Button>
          </span>
        ) : null}
      </div>
      <ErrorAlert title="Not saved" error={save.error} />

      {f ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={f.isBacktest ? `Cash on ${date(f.asOf)}` : 'Cash today'} value={money(f.opening, c)} sub={`${f.cashAccounts.length} cash and bank account${f.cashAccounts.length === 1 ? '' : 's'}`} />
            <Stat label={`In ${f.horizonDays} days (${date(f.end)})`} value={money(f.closing.base, c)} sub={<span className="whitespace-nowrap">range {money(f.closing.low, c)} – {money(f.closing.high, c)}</span>} tone={tone(f.closing.base)} />
            <Stat label="Lowest point" value={money(f.lowest.base.amount, c)} sub={`${date(f.lowest.base.date)} · low case ${money(f.lowest.low.amount, c)}`} tone={tone(f.lowest.base.amount)} />
            <Stat
              label="Minimum balance"
              value={money(f.minimumBalance, c)}
              sub={Number(f.minimumBalance) > 0 ? (f.belowBuffer.base ? `Expected below it from ${date(f.belowBuffer.base)}` : f.belowBuffer.low ? `Only the low case goes below it, from ${date(f.belowBuffer.low)}` : 'Not expected to go below it') : 'Not set'}
              tone={f.belowBuffer.base ? 'negative' : f.belowBuffer.low ? 'warning' : 'positive'}
            />
          </div>
          {f.belowBuffer.base ? (
            <p role="alert" className="mt-3 rounded border border-negative/40 bg-negative/10 px-4 py-2 text-sm text-negative">
              Cash is expected to fall below the minimum balance of {money(f.minimumBalance, c)} on {date(f.belowBuffer.base)}.
            </p>
          ) : null}

          <Card className="mt-4">
            <CardHeader title="Expected balance" description={`From ${date(f.start)} to ${date(f.end)}. The shaded band runs from the low case (money in late, money out early, doubtful invoices left out) to the high case.`} />
            <div className="px-4 pb-4">
              <ForecastChart days={f.days} minimumBalance={f.minimumBalance} currency={c} />
            </div>
          </Card>

          <Card className="mt-4">
            <CardHeader title={f.horizonDays <= 90 ? 'Week by week' : 'Month by month'} description="Expected balance at the end of each period, with its range." />
            <Table>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th numeric>From customers</Th>
                  <Th numeric>Planned in</Th>
                  <Th numeric>To vendors</Th>
                  <Th numeric>Planned out</Th>
                  <Th numeric>Net</Th>
                  <Th numeric>Closing (range)</Th>
                </tr>
              </thead>
              <tbody>
                {f.buckets.map((b) => (
                  <Tr key={b.from} aria-label={`${b.from} to ${b.to}`}>
                    <Td className="whitespace-nowrap">{date(b.from)} – {date(b.to)}</Td>
                    <Td numeric className="whitespace-nowrap"><Money value={b.inflows.RECEIVABLE} currency={c} /></Td>
                    <Td numeric className="whitespace-nowrap"><Money value={b.inflows.PLANNED_IN} currency={c} /></Td>
                    <Td numeric className="whitespace-nowrap"><Money value={b.outflows.PAYABLE} currency={c} /></Td>
                    <Td numeric className="whitespace-nowrap"><Money value={b.outflows.PLANNED_OUT} currency={c} /></Td>
                    <Td numeric className="whitespace-nowrap"><Money value={b.net} currency={c} signed /></Td>
                    <Td numeric className={tone(b.closing) === 'negative' ? 'text-negative' : undefined}>
                      <Money value={b.closing} currency={c} />
                      {b.low !== b.high ? <span className="block text-xs text-fg-muted">{money(b.low, c)} – {money(b.high, c)}</span> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <OpenItems title="Money in from customers" items={f.receivables} end={f.end} currency={c} delays={f.delays.customers} unapplied={f.unapplied.receipts} unappliedLabel="Receipts not yet matched to an invoice" />
            <OpenItems title="Money out to vendors" items={f.payables} end={f.end} currency={c} delays={f.delays.vendors} unapplied={f.unapplied.payments} unappliedLabel="Payments not yet matched to a bill" />
          </div>
        </>
      ) : null}

      <PlannedItems canManage={canManage} currency={c} />
      <MinimumBalance canManage={canManage} currency={c} />

      <Card className="mt-4">
        <CardHeader title="Saved forecasts and backtests" description="A saved forecast never changes. As the days pass it is compared with the actual cash balance, so you can see how far to trust the forecast. A backtest is a forecast rebuilt from the books as they stood on an earlier day; it uses today's planned items." />
        {saved.data?.length ? (
          <Table>
            <thead>
              <tr>
                <Th>From</Th>
                <Th>Horizon</Th>
                <Th numeric>Opening</Th>
                <Th numeric>Expected closing</Th>
                <Th numeric>Days measured</Th>
                <Th numeric>Average miss</Th>
                <Th numeric>Inside the range</Th>
                <Th>Saved by</Th>
              </tr>
            </thead>
            <tbody>
              {saved.data.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/cash-flow/forecasts/${s.id}`}>{date(s.asOf)}</Link>
                    {s.isBacktest ? <Badge tone="accent" className="ml-2">Backtest</Badge> : null}
                    {s.note ? <span className="block text-xs text-fg-muted">{s.note}</span> : null}
                  </Td>
                  <Td>{s.horizonDays} days</Td>
                  <Td numeric><Money value={s.opening} currency={c} /></Td>
                  <Td numeric><Money value={s.closingBase} currency={c} /></Td>
                  <Td numeric>{s.accuracy.days} of {s.horizonDays}</Td>
                  <Td numeric>{s.accuracy.days ? <Money value={s.accuracy.meanAbsoluteError} currency={c} /> : '—'}</Td>
                  <Td numeric>{s.accuracy.days ? `${s.accuracy.withinRange}%` : '—'}</Td>
                  <Td className="text-fg-muted">{s.createdBy}, {date(s.createdAt.slice(0, 10))}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : saved.data ? (
          <p className="px-4 pb-4 text-sm text-fg-muted">Nothing saved yet. Save today&apos;s forecast to measure it later, or pick an earlier &ldquo;As of&rdquo; date and save a backtest to see how it would have done.</p>
        ) : null}
      </Card>
    </>
  );
}

function OpenItems({ title, items, end, currency, delays, unapplied, unappliedLabel }: { title: string; items: OpenItem[]; end: string; currency: string; delays: CashForecast['delays']['customers']; unapplied: string; unappliedLabel: string }) {
  const inside = items.filter((i) => i.inHorizon);
  const later = items.length - inside.length;
  return (
    <Card>
      <CardHeader
        title={title}
        description={delays.median !== null ? `Usually paid ${timing(delays.median)} (middle half: ${timing(delays.p25!)} to ${timing(delays.p75!)}), from ${delays.samples} documents settled in the last year.` : `Fewer than 3 documents settled in the last year (${delays.samples}), so due dates are used.`}
      />
      {inside.length ? (
        <Table>
          <thead>
            <tr>
              <Th>Contact</Th>
              <Th>Due</Th>
              <Th>Expected</Th>
              <Th numeric>Open</Th>
            </tr>
          </thead>
          <tbody>
            {inside.map((i) => (
              <Tr key={i.id} aria-label={`${i.contactName} ${i.number}`}>
                <Td>
                  {i.contactName}
                  <span className="block text-xs text-fg-muted">{i.number}</span>
                </Td>
                <Td className="whitespace-nowrap">{date(i.dueDate)}</Td>
                <Td>
                  <span className="whitespace-nowrap">{date(i.expected.base)}</span>
                  <span className="block text-xs text-fg-muted">
                    {i.expected.early !== i.expected.late ? `${date(i.expected.early)} – ${date(i.expected.late)} · ` : ''}
                    {BASIS[i.basis.source]}
                    {i.basis.source === 'CONTACT' ? ` (${i.basis.samples} paid, usually ${timing(i.basis.medianDelay ?? 0)})` : ''}
                  </span>
                  {i.doubtful ? <Badge tone="negative">Doubtful: high case only</Badge> : i.pastTypical ? <Badge tone="warning">Later than usual</Badge> : null}
                </Td>
                <Td numeric><Money value={i.open} currency={currency} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="px-4 pb-4 text-sm text-fg-muted">Nothing expected by {date(end)}.</p>
      )}
      <p className="px-4 pb-4 text-xs text-fg-muted">
        {later ? `${later} more expected after ${date(end)}. ` : ''}
        {Number(unapplied) > 0 ? `${unappliedLabel}: ${money(unapplied, currency)} (not in the forecast).` : ''}
      </p>
    </Card>
  );
}

function PlannedItems({ canManage, currency }: { canManage: boolean; currency: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ['cash-items', orgId], queryFn: () => api<PlannedItem[]>(`/v1/orgs/${orgId}/cash-flow/items`) });
  const [editing, setEditing] = useState<PlannedItem | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/orgs/${orgId}/cash-flow/items/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cash-items', orgId] });
      void qc.invalidateQueries({ queryKey: ['cash-forecast', orgId] });
    },
  });
  return (
    <Card className="mt-4">
      <CardHeader
        title="Planned receipts and payments"
        description="Cash the books do not show yet: rent, salaries, loan instalments, tax payments, a planned sale. Don't add anything already in an open invoice or bill, or it will be counted twice."
        actions={canManage ? <Button size="sm" onClick={() => setEditing('new')}>Add planned item</Button> : null}
      />
      <ErrorAlert title="Not removed" error={remove.error} />
      {items.data?.length ? (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>How often</Th>
              <Th>From</Th>
              <Th>Until</Th>
              <Th numeric>Amount</Th>
              {canManage ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {items.data.map((i) => (
              <Tr key={i.id} aria-label={i.name} className={i.isActive ? undefined : 'opacity-60'}>
                <Td>
                  {i.name}
                  {!i.isActive ? <Badge className="ml-2">Paused</Badge> : null}
                  {i.note ? <span className="block text-xs text-fg-muted">{i.note}</span> : null}
                </Td>
                <Td>{FREQUENCY[i.frequency]}</Td>
                <Td className="whitespace-nowrap">{date(i.startDate)}</Td>
                <Td className="whitespace-nowrap">{i.frequency === 'ONCE' ? '—' : i.endDate ? date(i.endDate) : 'No end'}</Td>
                <Td numeric className={i.direction === 'OUT' ? 'text-negative' : 'text-positive'}>
                  {i.direction === 'OUT' ? '−' : '+'}
                  {money(i.amount, currency)}
                </Td>
                {canManage ? (
                  <Td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>Edit</Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${i.name}`} loading={remove.isPending && remove.variables === i.id} onClick={() => remove.mutate(i.id)}>Remove</Button>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : items.data ? (
        <EmptyState title="No planned items">Add the regular payments the books cannot know about yet, such as rent and salaries.</EmptyState>
      ) : null}
      {editing ? <ItemDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function ItemDialog({ item, onClose }: { item: PlannedItem | null; onClose: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: item?.name ?? '',
    direction: item?.direction ?? ('OUT' as 'IN' | 'OUT'),
    amount: item?.amount ?? '',
    frequency: item?.frequency ?? ('MONTHLY' as Frequency),
    startDate: item?.startDate ?? '',
    endDate: item?.endDate ?? '',
    note: item?.note ?? '',
    isActive: item?.isActive ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), direction: form.direction, amount: form.amount.trim(), frequency: form.frequency, startDate: form.startDate, endDate: form.frequency === 'ONCE' || !form.endDate ? null : form.endDate, note: form.note.trim() || null, isActive: form.isActive };
      return item ? api(`/v1/orgs/${orgId}/cash-flow/items/${item.id}`, { method: 'PUT', body }) : api(`/v1/orgs/${orgId}/cash-flow/items`, { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cash-items', orgId] });
      void qc.invalidateQueries({ queryKey: ['cash-forecast', orgId] });
      onClose();
    },
  });
  const amountError = form.amount && (!AMOUNT.test(form.amount.trim()) || Number(form.amount) <= 0) ? 'More than zero, at most 2 decimals' : undefined;
  const endError = form.frequency !== 'ONCE' && form.endDate && form.startDate && form.endDate < form.startDate ? 'Before the start date' : undefined;
  const ok = form.name.trim() && form.amount && !amountError && form.startDate && !endError;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={item ? 'Edit planned item' : 'Add planned item'} description="The forecast counts it on each date it falls due within the horizon.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <ErrorAlert title="Not saved" error={save.error} />
        <Field label="Name">{(p) => <Input {...p} maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Money">
            {(p) => (
              <Select {...p} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as 'IN' | 'OUT' })}>
                <option value="OUT">Out (a payment)</option>
                <option value="IN">In (a receipt)</option>
              </Select>
            )}
          </Field>
          <Field label="Amount" error={amountError}>{(p) => <Input {...p} inputMode="decimal" className="num" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="How often">
            {(p) => (
              <Select {...p} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}>
                {Object.entries(FREQUENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
          <Field label={form.frequency === 'ONCE' ? 'Date' : 'First date'}>{(p) => <Input {...p} type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />}</Field>
          {form.frequency !== 'ONCE' ? <Field label="Last date (optional)" error={endError}>{(p) => <Input {...p} type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />}</Field> : null}
        </div>
        <Field label="Note (optional)">{(p) => <Input {...p} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
        {item ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!form.isActive} onChange={(e) => setForm({ ...form, isActive: !e.target.checked })} />
            Paused (left out of the forecast)
          </label>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!ok}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function MinimumBalance({ canManage, currency }: { canManage: boolean; currency: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['cash-settings', orgId], queryFn: () => api<{ minimumBalance: string; currency: string }>(`/v1/orgs/${orgId}/cash-flow/settings`) });
  const [value, setValue] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/cash-flow/settings`, { method: 'PUT', body: { minimumBalance: (value ?? '').trim() } }),
    onSuccess: () => {
      setValue(null);
      void qc.invalidateQueries({ queryKey: ['cash-settings', orgId] });
      void qc.invalidateQueries({ queryKey: ['cash-forecast', orgId] });
    },
  });
  if (!s.data) return null;
  const v = value ?? s.data.minimumBalance;
  const error = AMOUNT.test(v.trim()) ? undefined : 'An amount with at most 2 decimals';
  return (
    <Card className="mt-4">
      <CardHeader title="Minimum balance" description="The forecast warns when cash is expected to fall below this amount. Use 0 for no warning." />
      <form className="flex flex-wrap items-end gap-3 px-4 pb-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={`Minimum balance (${currency})`} error={value !== null ? error : undefined}>
          {(p) => <Input {...p} inputMode="decimal" className="num w-48" disabled={!canManage} value={v} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        {canManage ? <Button type="submit" variant="secondary" loading={save.isPending} disabled={value === null || !!error}>Save minimum</Button> : null}
        <ErrorAlert title="Not saved" error={save.error} />
      </form>
    </Card>
  );
}
