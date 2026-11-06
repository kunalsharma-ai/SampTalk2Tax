'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RISK_LABEL, type RiskRating } from '@talk2tax/accounting-engine';
import { chartSeries } from '@talk2tax/design-system';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { pctOf, type CustomerInsight } from '@/lib/customer-insights';
import { date, dateTime, money } from '@/lib/format';

const RISK_TONE: Record<RiskRating, 'positive' | 'warning' | 'negative' | 'neutral'> = { LOW: 'positive', MEDIUM: 'warning', HIGH: 'negative', VERY_HIGH: 'negative', NO_HISTORY: 'neutral' };

export function RiskBadge({ rating, score }: { rating: RiskRating; score?: number | null }) {
  return <Badge tone={RISK_TONE[rating]}>{RISK_LABEL[rating]}{score != null ? ` · ${score}` : ''}</Badge>;
}

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const days = (n: number | null) => (n == null ? '—' : `${n} ${n === 1 ? 'day' : 'days'}`);

/** Customer 360 on the customer's page: profit, lifetime value, payment behaviour and credit risk. */
export function Customer360({ orgId, contactId, currency }: { orgId: string; contactId: string; currency: string }) {
  const qc = useQueryClient();
  const [holding, setHolding] = useState<null | 'set' | 'lift'>(null);
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['customer-insights', orgId, contactId], queryFn: () => api<CustomerInsight>(`/v1/orgs/${orgId}/customers/${contactId}/insights`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['customer-insights', orgId] });
    await qc.invalidateQueries({ queryKey: ['contact', orgId, contactId] });
  };
  const hold = useMutation({
    mutationFn: (h: boolean) => api(`/v1/orgs/${orgId}/customers/${contactId}/credit-hold`, { method: 'PUT', body: { hold: h, reason: reason.trim() || null } }),
    onSuccess: async () => { setHolding(null); setReason(''); await refresh(); },
  });
  const limit = useMutation({
    mutationFn: (creditLimit: string) => api(`/v1/orgs/${orgId}/contacts/${contactId}`, { method: 'PATCH', body: { creditLimit } }),
    onSuccess: refresh,
  });
  if (q.error) return <div className="mt-6"><ErrorAlert title="Could not load the customer's figures" error={q.error} /></div>;
  const x = q.data;
  if (!x) return <p className="mt-6 text-sm text-fg-muted">Working out profit and risk…</p>;
  const c = currency;
  const rows = x.months.map((m) => ({ label: monthLabel(m.month), revenue: Number(m.revenue), cost: Number(m.cost), profit: Number(m.profit), raw: m }));
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const b = x.behaviour;
  return (
    <section className="mt-6" aria-label="Customer 360">
      {x.creditHold ? (
        <Alert title="On credit hold">
          No invoice to {x.name} posts until the hold is lifted. {x.creditHoldReason}
          {x.creditHoldBy ? ` (${x.creditHoldBy}${x.creditHoldAt ? `, ${dateTime(x.creditHoldAt)}` : ''})` : ''}
          {x.can.manage ? <div className="mt-2"><Button size="sm" variant="secondary" onClick={() => setHolding('lift')}>Lift the hold</Button></div> : null}
        </Alert>
      ) : null}
      <h2 className="mb-3 mt-6 text-lg font-semibold">Customer 360</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Lifetime value" value={<Money value={x.lifetime.value} currency={c} />} tone="accent" sub={`${x.lifetime.expectedYears} more years expected${x.lifetime.assumedYears ? ' (assumed)' : ''}`} />
        <Stat label="Gross profit to date" value={<Money value={x.toDate.profit} currency={c} signed />} tone="positive" sub={`Margin ${pctOf(x.toDate.margin)} on ${money(x.toDate.revenue, c)} revenue`} />
        <Stat label="Last 12 months revenue" value={<Money value={x.trailing.revenue} currency={c} />} tone="violet" sub={x.contracts.active ? `Contracts ${money(x.contracts.arr, c)} a year` : 'No active contract'} />
        <Stat label="Credit risk" value={<RiskBadge rating={x.risk.rating} score={x.risk.score} />} tone={x.risk.rating === 'HIGH' || x.risk.rating === 'VERY_HIGH' ? 'negative' : 'neutral'} sub={`Pays in ${days(b.averageDaysToPay)} on average`} />
      </div>

      <Card className="mt-6">
        <CardHeader title="Profitability" description="Revenue is what invoices charged before tax, less credit notes. Direct costs are expenses posted to this customer's projects." />
        <div className="px-5 pt-2">
          <div className="h-64 w-full" role="img" aria-label="Revenue, direct costs and gross profit by month. The same figures are in the table below.">
            <ResponsiveContainer>
              <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
                <Tooltip
                  cursor={{ fill: 'rgba(14,165,233,0.08)' }}
                  contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
                  formatter={(_v, name, item) => {
                    const raw = (item.payload as { raw: CustomerInsight['months'][number] }).raw;
                    return [money(name === 'Revenue' ? raw.revenue : name === 'Direct costs' ? raw.cost : raw.profit, c), name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
                <Bar dataKey="revenue" name="Revenue" fill={chartSeries[0]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={!reducedMotion} />
                <Bar dataKey="cost" name="Direct costs" fill={chartSeries[1]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={!reducedMotion} />
                <Line dataKey="profit" name="Gross profit" stroke={chartSeries[2]} strokeWidth={2} dot={{ r: 3 }} type="monotone" isAnimationActive={!reducedMotion} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
        <Table aria-label="Monthly profitability">
          <thead><tr><Th>Month</Th><Th numeric>Revenue</Th><Th numeric>Direct costs</Th><Th numeric>Gross profit</Th></tr></thead>
          <tbody>
            {x.months.map((m) => (
              <Tr key={m.month}><Td>{monthLabel(m.month)}</Td><Td numeric><Money value={m.revenue} currency={c} /></Td><Td numeric><Money value={m.cost} currency={c} /></Td><Td numeric><Money value={m.profit} currency={c} signed /></Td></Tr>
            ))}
          </tbody>
          <tfoot>
            <tr><Td className="font-semibold">Last 12 months</Td><Td numeric className="font-semibold"><Money value={x.trailing.revenue} currency={c} /></Td><Td numeric className="font-semibold"><Money value={x.trailing.cost} currency={c} /></Td><Td numeric className="font-semibold"><Money value={x.trailing.profit} currency={c} signed /> <span className="text-xs text-fg-muted">({pctOf(x.trailing.margin)})</span></Td></tr>
            <tr><Td className="font-semibold">Since {x.customerSince ? date(x.customerSince) : 'the start'}</Td><Td numeric className="font-semibold"><Money value={x.toDate.revenue} currency={c} /></Td><Td numeric className="font-semibold"><Money value={x.toDate.cost} currency={c} /></Td><Td numeric className="font-semibold"><Money value={x.toDate.profit} currency={c} signed /> <span className="text-xs text-fg-muted">({pctOf(x.toDate.margin)})</span></Td></tr>
          </tfoot>
        </Table>
        <div className="border-t border-line px-5 py-3 text-sm">
          {x.projects.length ? (
            <ul className="flex flex-wrap gap-x-6 gap-y-1" aria-label="Customer projects">
              {x.projects.map((p) => <li key={p.id}><span className="font-medium">{p.code}</span> {p.name}: <Money value={p.cost} currency={c} /> of direct costs{p.isActive ? '' : ' (inactive)'}</li>)}
            </ul>
          ) : (
            <p className="text-fg-muted">No project is linked to this customer, so no direct costs are counted. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/dimensions`}>Link a project</Link> and tag bills and journals to it.</p>
          )}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Credit risk"
            description="A score from 0 (safe) to 100, from how this customer pays. Under 25 is low risk, under 50 medium, under 75 high."
            actions={x.can.manage && !x.creditHold && x.risk.rating !== 'NO_HISTORY' ? <Button size="sm" variant="secondary" onClick={() => setHolding('set')}>Put on credit hold</Button> : null}
          />
          {x.risk.factors.length ? (
            <Table aria-label="Credit risk factors">
              <thead><tr><Th>Factor</Th><Th>What we see</Th><Th numeric>Points</Th></tr></thead>
              <tbody>
                {x.risk.factors.map((f) => <Tr key={f.key}><Td>{f.label}</Td><Td className="text-fg-muted">{f.detail}</Td><Td numeric>{f.points} / {f.max}</Td></Tr>)}
              </tbody>
              <tfoot><tr><Td colSpan={2} className="font-semibold">Score</Td><Td numeric className="font-semibold">{x.risk.score}</Td></tr></tfoot>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No posted invoices yet, so there is nothing to score.</p>}
          <div className="border-t border-line px-5 py-3 text-sm">
            <p>Credit limit: {x.creditLimit ? money(x.creditLimit, c) : 'none set'}.{x.risk.suggestedLimit ? <> A month of billing plus {x.paymentTermsDays} days of terms{x.risk.rating === 'MEDIUM' ? ', halved for medium risk,' : ''} suggests <strong>{money(x.risk.suggestedLimit, c)}</strong>.</> : null}</p>
            {x.can.manage && x.risk.suggestedLimit && x.risk.suggestedLimit !== x.creditLimit ? (
              <Button className="mt-2" size="sm" variant="secondary" loading={limit.isPending} onClick={() => limit.mutate(x.risk.suggestedLimit!)}>Use {money(x.risk.suggestedLimit, c)} as the credit limit</Button>
            ) : null}
            <ErrorAlert title="Limit not changed" error={limit.error} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Payment behaviour" description="An invoice is paid on the day the receipt or credit that clears it is applied." />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 text-sm" aria-label="Payment behaviour">
            <div><dt className="text-fg-muted">Invoices posted</dt><dd className="font-medium">{b.invoices} ({b.paidInvoices} paid)</dd></div>
            <div><dt className="text-fg-muted">Paid on time</dt><dd className="font-medium">{pctOf(b.onTimeShare)}</dd></div>
            <div><dt className="text-fg-muted">Average days to pay</dt><dd className="font-medium">{days(b.averageDaysToPay)}</dd></div>
            <div><dt className="text-fg-muted">Average days late</dt><dd className="font-medium">{days(b.averageDaysLate)}</dd></div>
            <div><dt className="text-fg-muted">Open</dt><dd className="font-medium"><Money value={b.open} currency={c} /></dd></div>
            <div><dt className="text-fg-muted">Overdue</dt><dd className="font-medium"><Money value={b.overdue} currency={c} />{b.oldestOverdueDays ? ` (oldest ${b.oldestOverdueDays} days)` : ''}</dd></div>
          </dl>
          <div className="border-t border-line px-5 py-3 text-sm">
            <h3 className="mb-1 font-medium">How lifetime value is worked out</h3>
            <p className="text-fg-muted">
              {money(x.lifetime.earnedToDate, c)} gross profit earned so far, plus {money(x.lifetime.annualProfit, c)} a year ({money(x.lifetime.annualRevenue, c)} revenue at a {pctOf(x.lifetime.margin)} margin) for {x.lifetime.expectedYears} years.{' '}
              {x.lifetime.assumedYears
                ? `Fewer than five customers were billed a year before last, so three years is assumed.`
                : `${x.retention.retained} of the ${x.retention.customers} customers billed in the twelve months before last were billed again in the last twelve (${pctOf(x.retention.rate)}), which means about ${x.lifetime.expectedYears} more years on average.`}
            </p>
          </div>
        </Card>
      </div>

      <Dialog open={holding !== null} onOpenChange={(o) => !o && setHolding(null)} title={holding === 'lift' ? `Lift the credit hold on ${x.name}` : `Put ${x.name} on credit hold`} description={holding === 'lift' ? 'Invoices to this customer can post again.' : 'No invoice to this customer posts until the hold is lifted. Drafts, quotations and credit notes still work.'}>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); hold.mutate(holding === 'set'); }}>
          <Field label={holding === 'lift' ? 'Why is it lifted? (optional)' : 'Why is it on hold?'}>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required={holding === 'set'} />}</Field>
          <ErrorAlert title="Not changed" error={hold.error} />
          <div className="flex gap-2"><Button type="submit" loading={hold.isPending}>{holding === 'lift' ? 'Lift the hold' : 'Put on hold'}</Button><Button type="button" variant="ghost" onClick={() => setHolding(null)}>Cancel</Button></div>
        </form>
      </Dialog>
    </section>
  );
}
