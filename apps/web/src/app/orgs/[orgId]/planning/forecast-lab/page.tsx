'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { AccuracyChart } from '@/components/forecast-lab/accuracy-chart';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { type LabOverview, type LabRun, type LabRunItem, type LabSeries, monthName, pct } from '@/lib/forecast-lab';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** The forecast evaluation lab: which simple model would have forecast this business best. */
export default function ForecastLabPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [window, setWindow] = useState(12);
  const [series, setSeries] = useState<LabSeries>('revenue');
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['forecast-lab', orgId, window], queryFn: () => api<LabOverview>(`/v1/orgs/${orgId}/forecast-lab?window=${window}`) });
  const runs = useQuery({ queryKey: ['forecast-lab-runs', orgId], queryFn: () => api<{ items: LabRunItem[] }>(`/v1/orgs/${orgId}/forecast-lab/runs`) });
  const save = useMutation({ mutationFn: () => api<LabRun>(`/v1/orgs/${orgId}/forecast-lab/runs`, { method: 'POST', body: { window, note: note.trim() || null } }), onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['forecast-lab-runs', orgId] });
      void qc.invalidateQueries({ queryKey: ['forecast-lab', orgId] });
      router.push(`/orgs/${orgId}/planning/forecast-lab/runs/${r.id}`);
    },
  });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  const label = Object.fromEntries((d?.meta.models ?? []).map((m) => [m.key, m.label]));
  const bt = d?.series.find((s) => s.series === series);
  const ranked = bt ? [...bt.models].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) : [];
  const ahead = (d?.ahead ?? []).filter((f) => f.series === series);
  const aheadMonths = [...new Set(ahead.map((f) => f.month))].sort();
  const tracking = d?.tracking.series.find((s) => s.series === series);
  const chartModels = bt?.best ? [...new Set([bt.best, 'NAIVE'])] : [];
  return (
    <>
      <PageHeader
        title="Forecast evaluation lab"
        description="Eight simple forecasting methods tested on your own books: each forecasts the months that already happened using only the months before, and is scored on how close it came."
        actions={
          <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Months checked
            <Select aria-label="Months checked" className="w-24" value={window} onChange={(e) => setWindow(Number(e.target.value))}>
              {[6, 12, 18].map((w) => <option key={w} value={w}>{w}</option>)}
            </Select>
          </label>
        }
      />
      <ErrorAlert title="Could not run the lab" error={q.error ?? save.error} />
      {d && d.historyMonths < 2 ? (
        <Card><EmptyState title="Not enough books yet">The lab needs at least two months of posted figures to test any method.</EmptyState></Card>
      ) : d && bt ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Figure
              <Select aria-label="Figure" className="w-56" value={series} onChange={(e) => setSeries(e.target.value as LabSeries)}>
                {d.meta.series.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </label>
            <p className="text-sm text-fg-muted">
              {d.historyMonths} months of books, {monthName(d.firstMonth!)} to {monthName(d.baseMonth)}. Checked on the last {bt.months.length}.
            </p>
          </div>

          <Card>
            <CardHeader title={d.meta.series.find((s) => s.key === series)!.label} description={d.meta.series.find((s) => s.key === series)!.description} />
            <div className="px-5 pb-5">
              <p className="mb-3 text-sm" data-testid="lab-summary">{bt.summary}</p>
              {chartModels.length ? <AccuracyChart bt={bt} models={chartModels} labels={label} currency={c} /> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="How each method did" description="Error is the total miss as a share of the actual figures (lower is better). Bias above zero means the method forecast too high." />
            <Table aria-label="Method accuracy">
              <thead>
                <tr>
                  <Th>Rank</Th>
                  <Th>Method</Th>
                  <Th numeric>Error</Th>
                  <Th numeric>1 month ahead</Th>
                  <Th numeric>2 months</Th>
                  <Th numeric>3 months</Th>
                  <Th numeric>Average miss</Th>
                  <Th numeric>Bias</Th>
                  <Th numeric>Within 10%</Th>
                  <Th numeric>Checked</Th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((m) => (
                  <Tr key={m.model}>
                    <Td className="num">{m.rank ?? '—'}</Td>
                    <Td>
                      <span className="font-medium">{label[m.model]}</span> {m.model === bt.best ? <Badge tone="positive">Best</Badge> : null}
                      <p className="max-w-[340px] text-xs text-fg-muted">{m.note ?? d.meta.models.find((x) => x.key === m.model)!.description}</p>
                    </Td>
                    <Td numeric>{pct(m.stats.wape)}</Td>
                    {m.byHorizon.map((h) => <Td key={h.horizon} numeric>{pct(h.stats.wape)}</Td>)}
                    <Td numeric>{m.stats.mae === null ? '—' : <Money value={m.stats.mae} currency={c} />}</Td>
                    <Td numeric>{m.stats.bias === null ? '—' : <Money value={m.stats.bias} currency={c} signed />}</Td>
                    <Td numeric>{pct(m.stats.within10)}</Td>
                    <Td numeric>{m.stats.count}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="What each method forecasts next" description={`From the books up to ${monthName(d.baseMonth)}.`} />
            <Table aria-label="Next three months">
              <thead>
                <tr>
                  <Th>Method</Th>
                  {aheadMonths.map((m) => <Th key={m} numeric>{monthName(m)}</Th>)}
                </tr>
              </thead>
              <tbody>
                {ranked.map((m) => (
                  <Tr key={m.model}>
                    <Td>{label[m.model]} {m.model === bt.best ? <Badge tone="positive">Best</Badge> : null}</Td>
                    {aheadMonths.map((month) => {
                      const f = ahead.find((x) => x.model === m.model && x.month === month);
                      return <Td key={month} numeric>{f ? <Money value={f.value} currency={c} signed /> : '—'}</Td>;
                    })}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Saved forecasts, measured" description={d.tracking.runs ? `${d.tracking.runs} saved run${d.tracking.runs === 1 ? '' : 's'}. Each forecast is scored against the books once its month is over.` : 'Save a run to keep these forecasts and see later how they turned out.'} />
            {tracking && tracking.models.some((m) => m.stats.count) ? (
              <Table aria-label="Saved forecast accuracy">
                <thead>
                  <tr>
                    <Th>Method</Th>
                    <Th numeric>Error</Th>
                    <Th numeric>Average miss</Th>
                    <Th numeric>Forecasts measured</Th>
                  </tr>
                </thead>
                <tbody>
                  {tracking.models.filter((m) => m.stats.count).map((m) => (
                    <Tr key={m.model}>
                      <Td>{label[m.model]} {m.model === tracking.best ? <Badge tone="positive">Most accurate so far</Badge> : null}</Td>
                      <Td numeric>{pct(m.stats.wape)}</Td>
                      <Td numeric>{m.stats.mae ? <Money value={m.stats.mae} currency={c} /> : '—'}</Td>
                      <Td numeric>{m.stats.count}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="px-5 pb-3 text-sm text-fg-muted">No saved forecast has reached its month yet.</p>
            )}
            {can(org.role, 'budgets.manage') ? (
              <form
                className="flex flex-wrap items-end gap-2 px-5 pb-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate();
                }}
              >
                <div className="min-w-[280px] flex-1">
                  <label htmlFor="lab-note" className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted">Note for this run</label>
                  <Input id="lab-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Optional, such as “before the budget meeting”" />
                </div>
                <Button type="submit" loading={save.isPending}>Save this run</Button>
              </form>
            ) : null}
            {runs.data?.items.length ? (
              <Table aria-label="Saved runs">
                <thead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Books up to</Th>
                    <Th>Forecast months</Th>
                    <Th>Measured</Th>
                    <Th>Saved</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <Link className="num text-accent hover:underline" href={`/orgs/${orgId}/planning/forecast-lab/runs/${r.id}`}>{r.number}</Link>
                        {r.note ? <span className="ml-2 text-xs text-fg-muted">{r.note}</span> : null}
                      </Td>
                      <Td className="text-sm">{monthName(r.baseMonth)}</Td>
                      <Td className="text-sm">{r.forecastMonths.map(monthName).join(', ')}</Td>
                      <Td className="text-sm">{r.measuredMonths.length ? r.measuredMonths.map(monthName).join(', ') : 'Not yet'}</Td>
                      <Td className="text-sm text-fg-muted">{dateTime(r.createdAt)}{r.createdBy ? ` · ${r.createdBy}` : ''}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="The figures behind the chart" />
            <Table aria-label="Actual and forecast by month">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th numeric>Actual</Th>
                  {chartModels.map((m) => <Th key={m} numeric>{label[m]}, 1 month ahead</Th>)}
                </tr>
              </thead>
              <tbody>
                {bt.actuals.map((a) => (
                  <Tr key={a.month}>
                    <Td>{monthName(a.month)}</Td>
                    <Td numeric><Money value={a.value} currency={c} signed /></Td>
                    {chartModels.map((m) => {
                      const p = bt.models.find((x) => x.model === m)?.points.find((x) => x.month === a.month && x.horizon === 1);
                      return <Td key={m} numeric>{p ? <Money value={p.forecast} currency={c} signed /> : '—'}</Td>;
                    })}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Testing the methods…</p>
      )}
    </>
  );
}
