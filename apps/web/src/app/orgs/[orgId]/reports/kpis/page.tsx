'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr, cn } from '@talk2tax/ui';
import { chartSeries } from '@talk2tax/design-system';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Sparkline } from '@/components/kpis/sparkline';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { formatChange, formatKpi, GROUPS, type Comparator, type Kpi, type KpiReport, monthLabel, recentMonths } from '@/lib/kpis';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function KpisPage() {
  return (
    <Suspense>
      <Kpis />
    </Suspense>
  );
}

const STATUS = { MET: { label: 'Target met', tone: 'positive' }, MISSED: { label: 'Target missed', tone: 'negative' }, NO_VALUE: { label: 'No value', tone: 'neutral' } } as const;

function Kpis() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const month = params.get('month');
  const q = useQuery({ queryKey: ['kpis', orgId, month], queryFn: () => api<KpiReport>(`/v1/orgs/${orgId}/kpis${month ? `?month=${month}` : ''}`) });
  const [open, setOpen] = useState<string | null>(null);
  if (!org) return null;
  const d = q.data;
  const c = d?.currency ?? org.functionalCurrency;
  const canManage = can(org.role, 'budgets.manage');
  const selected = d?.kpis.find((k) => k.key === open) ?? null;
  return (
    <>
      <PageHeader
        title="KPIs"
        description="Financial KPIs computed from posted journals for one month, compared with the month before and the same month last year. Open a KPI to see how it is calculated and the figures behind it, its last 13 months and its target."
        actions={
          <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Month
            <Select className="w-40" value={d?.month ?? ''} onChange={(e) => router.replace(`/orgs/${orgId}/reports/kpis?month=${e.target.value}`)}>
              {recentMonths(today(), 24).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
          </label>
        }
      />
      <ErrorAlert title="Could not load KPIs" error={q.error} />
      {d ? (
        <>
          <p className="mb-4 text-sm text-fg-muted">
            {date(d.from)} to {date(d.to)}
            {d.inProgress ? <Badge tone="warning" className="ml-2">Month in progress</Badge> : null} · compared with {monthLabel(d.previousMonth)} and {monthLabel(d.sameMonthLastYear)}.{' '}
            <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/management/${d.month}`}>Management report for {monthLabel(d.month)}</Link>
          </p>
          {GROUPS.map((g) => (
            <section key={g.key} className="mb-6" aria-label={g.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{g.label}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {d.kpis.filter((k) => k.group === g.key).map((k) => <KpiCard key={k.key} k={k} currency={c} onOpen={() => setOpen(k.key)} />)}
              </div>
            </section>
          ))}
          <Card>
            <CardHeader title="Revenue by customer" description={`Posted invoices less credit notes, ${date(d.customers.from)} to ${date(d.customers.to)}, without tax. ${d.customers.customers} customer${d.customers.customers === 1 ? '' : 's'}.`} />
            {d.customers.top.length ? (
              <>
                {d.customers.largestShare && Number(d.customers.largestShare) >= 40 ? (
                  <p role="status" className="mx-4 mb-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                    {d.customers.top[0].name} is {d.customers.largestShare}% of revenue: losing it would hurt.
                  </p>
                ) : null}
                <Table>
                  <thead>
                    <tr>
                      <Th>Customer</Th>
                      <Th numeric>Revenue</Th>
                      <Th numeric>Share</Th>
                      <Th className="w-1/3" />
                    </tr>
                  </thead>
                  <tbody>
                    {d.customers.top.map((r) => (
                      <Tr key={r.id} aria-label={r.name}>
                        <Td>{r.name}</Td>
                        <Td numeric><Money value={r.revenue} currency={c} /></Td>
                        <Td numeric>{r.share}%</Td>
                        <Td><div className="h-2 rounded bg-surface-hover"><div className="h-2 rounded bg-accent" style={{ width: `${r.share}%` }} /></div></Td>
                      </Tr>
                    ))}
                    {d.customers.others.count ? (
                      <Tr>
                        <Td className="text-fg-muted">{d.customers.others.count} others</Td>
                        <Td numeric><Money value={d.customers.others.revenue} currency={c} /></Td>
                        <Td numeric>{d.customers.others.share}%</Td>
                        <Td />
                      </Tr>
                    ) : null}
                  </tbody>
                </Table>
              </>
            ) : (
              <p className="px-4 pb-4 text-sm text-fg-muted">No invoiced revenue in this period.</p>
            )}
          </Card>
          {selected ? <KpiDialog k={selected} currency={c} canManage={canManage} onClose={() => setOpen(null)} /> : null}
        </>
      ) : null}
    </>
  );
}

function KpiCard({ k, currency, onOpen }: { k: Kpi; currency: string; onOpen: () => void }) {
  const tone = k.target?.status === 'MISSED' ? 'var(--t2t-negative)' : k.target?.status === 'MET' ? 'var(--t2t-positive)' : chartSeries[0];
  return (
    <button type="button" onClick={onOpen} aria-label={`${k.label}: ${formatKpi(k.value, k.unit, currency)}`} className="rounded-lg border border-line bg-surface p-4 text-left transition hover:border-line-strong hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">{k.label}</span>
        {k.target ? <Badge tone={STATUS[k.target.status].tone}>{STATUS[k.target.status].label}</Badge> : null}
      </div>
      <div className="num mt-2 whitespace-nowrap text-2xl font-semibold">{formatKpi(k.value, k.unit, currency)}</div>
      <div className={cn('mt-1 text-xs', k.improved === true ? 'text-positive' : k.improved === false ? 'text-negative' : 'text-fg-muted')}>
        {k.value === null ? k.reason : k.change !== null ? `${formatChange(k.change, k.unit, currency)} vs last month` : 'No figure last month'}
      </div>
      <div className="mt-2">
        <Sparkline values={k.series.map((s) => s.value)} tone={tone} />
      </div>
    </button>
  );
}

function KpiDialog({ k, currency, canManage, onClose }: { k: Kpi; currency: string; canManage: boolean; onClose: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [form, setForm] = useState({ comparator: (k.target?.comparator ?? (k.better === 'HIGHER' ? 'AT_LEAST' : 'AT_MOST')) as Comparator, target: k.target?.target ?? '', note: k.target?.note ?? '' });
  const done = () => void qc.invalidateQueries({ queryKey: ['kpis', orgId] });
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/kpis/targets/${k.key}`, { method: 'PUT', body: { comparator: form.comparator, target: form.target.trim(), note: form.note.trim() || null } }), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/kpis/targets/${k.key}`, { method: 'DELETE' }), onSuccess: () => { setForm({ ...form, target: '', note: '' }); done(); } });
  const valid = /^-?\d{1,15}(\.\d{1,4})?$/.test(form.target.trim());
  const unitHint = { MONEY: currency, PERCENT: '%', RATIO: '×', DAYS: 'days', MONTHS: 'months' }[k.unit];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={k.label} description={k.formula}>
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <span className="num text-3xl font-semibold">{formatKpi(k.value, k.unit, currency)}</span>
          <span className="text-sm text-fg-muted">
            Last month {formatKpi(k.previous, k.unit, currency)} · a year ago {formatKpi(k.lastYear, k.unit, currency)}
          </span>
        </div>
        {k.value === null ? <p className="text-sm text-fg-muted">{k.reason}</p> : null}
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Calculated from</h3>
          <Table>
            <tbody>
              {k.components.map((x) => (
                <Tr key={x.label}>
                  <Td>{x.label}</Td>
                  <Td numeric><Money value={x.amount} currency={currency} signed /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Last 13 months</h3>
          <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-sm sm:grid-cols-7">
            {k.series.map((s) => (
              <div key={s.month} className="flex flex-col">
                <span className="text-xs text-fg-faint">{monthLabel(s.month)}</span>
                <span className="num whitespace-nowrap">{formatKpi(s.value, k.unit, currency)}</span>
              </div>
            ))}
          </div>
        </div>
        <form className="flex flex-col gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Target</h3>
          <ErrorAlert title="Target not saved" error={save.error ?? remove.error} />
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <Field label="Should be">
              {(p) => (
                <Select {...p} disabled={!canManage} value={form.comparator} onChange={(e) => setForm({ ...form, comparator: e.target.value as Comparator })}>
                  <option value="AT_LEAST">At least</option>
                  <option value="AT_MOST">At most</option>
                </Select>
              )}
            </Field>
            <Field label={`Target (${unitHint})`} error={form.target && !valid ? 'A number with at most 4 decimals' : undefined}>
              {(p) => <Input {...p} disabled={!canManage} inputMode="decimal" className="num" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />}
            </Field>
          </div>
          <Field label="Note (optional)">{(p) => <Input {...p} disabled={!canManage} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
          {canManage ? (
            <div className="flex justify-end gap-2">
              {k.target ? <Button type="button" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove target</Button> : null}
              <Button type="submit" loading={save.isPending} disabled={!valid}>Save target</Button>
            </div>
          ) : (
            <p className="text-xs text-fg-muted">Owners, admins and accountants can set targets.</p>
          )}
          {save.isSuccess && !save.isPending ? <p className="text-sm text-positive" role="status">Target saved.</p> : null}
        </form>
      </div>
    </Dialog>
  );
}
