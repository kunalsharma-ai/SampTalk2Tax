'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardHeader, Dialog, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { ForecastChart } from '@/components/revenue-forecast/forecast-chart';
import { ForecastItems, ForecastTable } from '@/components/revenue-forecast/forecast-tables';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { monthLabel, type RevenueForecast, type SavedForecast, type SavedForecastSummary } from '@/lib/revenue-forecast';

const pct = (s: string | null) => (s == null ? '—' : `${(Number(s) * 100).toFixed(1).replace(/\.0$/, '')}%`);

export default function RevenueForecastPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const [months, setMonths] = useState('12');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['revenue-forecast', orgId, months], queryFn: () => api<RevenueForecast>(`/v1/orgs/${orgId}/sales/revenue-forecast?months=${months}`) });
  const saved = useQuery({ queryKey: ['revenue-forecast', orgId, 'saved'], queryFn: () => api<{ forecasts: SavedForecastSummary[] }>(`/v1/orgs/${orgId}/sales/revenue-forecast/saved`) });
  const save = useMutation({
    mutationFn: () => api<SavedForecast>(`/v1/orgs/${orgId}/sales/revenue-forecast/saved`, { method: 'POST', body: { months: Number(months), note: note.trim() || null } }),
    onSuccess: async (f) => {
      setSaving(false);
      setNote('');
      await qc.invalidateQueries({ queryKey: ['revenue-forecast', orgId, 'saved'] });
      router.push(`/orgs/${orgId}/sales/revenue-forecast/${f.id}`);
    },
  });
  if (!org) return null;
  const f = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Revenue forecast"
        description="Revenue before tax still to come, month by month, from active contracts, open sales orders, open deals at their win probability and the run rate of other sales."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Months
              <Select aria-label="Months" className="w-24" value={months} onChange={(e) => setMonths(e.target.value)}>
                {['3', '6', '12', '24'].map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </label>
            {f?.can.save ? <Button onClick={() => setSaving(true)}>Save this forecast</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Could not work out the forecast" error={q.error} />
      {f ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={`Invoiced in ${monthLabel(f.months[0]!.month)} so far`} value={<Money value={f.actualSoFar} currency={c} />} tone="neutral" sub="Before tax, less credit notes" />
            <Stat label="Committed" value={<Money value={f.totals.committed} currency={c} />} tone="accent" sub="Contracts and sales orders" />
            <Stat label="Expected" value={<Money value={f.totals.expected} currency={c} />} tone="positive" sub={`Over ${f.horizon} months, with weighted deals and other sales`} />
            <Stat label="Best case" value={<Money value={f.totals.best} currency={c} />} tone="violet" sub="Every open deal won" />
          </div>
          <Card className="mt-6">
            <CardHeader title="By month" description={`Other sales run at ${money(f.otherRunRate, c)} a month: the average of the last three complete months from invoices not made from a contract or an order. This month's figures are what is still to come.`} />
            <div className="px-5 pt-2"><ForecastChart months={f.months} currency={c} actualSoFar={f.actualSoFar} /></div>
            <ForecastTable months={f.months} totals={f.totals} currency={c} />
          </Card>
          <Card className="mt-6">
            <CardHeader title="What the forecast is made of" description="Contract periods by invoice date (late ones this month), what is left on open orders (this month), and open deals in their expected close month (overdue ones this month)." />
            <ForecastItems items={f.items} orgId={orgId} currency={c} />
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Working out the forecast…</p> : null}
      <Card className="mt-6">
        <CardHeader title="Saved forecasts" description="A saved forecast keeps what was forecast that day. As months end it is compared with what was invoiced; WAPE is the total miss as a share of actual revenue." />
        {saved.data && saved.data.forecasts.length ? (
          <Table aria-label="Saved forecasts">
            <thead><tr><Th>Forecast</Th><Th>Made on</Th><Th>Months</Th><Th numeric>Expected</Th><Th numeric>Months over</Th><Th numeric>WAPE</Th><Th>Note</Th></tr></thead>
            <tbody>
              {saved.data.forecasts.map((s) => (
                <Tr key={s.id}>
                  <Td className="num"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/revenue-forecast/${s.id}`}>{s.reference}</Link></Td>
                  <Td className="whitespace-nowrap">{date(s.asOf)}{s.createdBy ? <span className="text-fg-muted"> · {s.createdBy}</span> : null}</Td>
                  <Td>{s.months}</Td>
                  <Td numeric><Money value={s.expected} currency={c} /></Td>
                  <Td numeric>{s.monthsOver}</Td>
                  <Td numeric>{pct(s.wape)}</Td>
                  <Td className="text-fg-muted">{s.note}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">{saved.data ? 'None saved yet.' : 'Loading…'}</p>}
      </Card>
      <Dialog open={saving} onOpenChange={setSaving} title="Save this forecast" description={`Keeps the ${months}-month forecast as it stands today. It never changes, so you can compare it with what is invoiced.`}>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Note (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
          <ErrorAlert title="Not saved" error={save.error} />
          <div className="flex gap-2"><Button type="submit" loading={save.isPending}>Save forecast</Button><Button type="button" variant="ghost" onClick={() => setSaving(false)}>Cancel</Button></div>
        </form>
      </Dialog>
    </>
  );
}
