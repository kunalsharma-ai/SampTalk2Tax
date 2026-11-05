'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { type LabRun, monthName, pct } from '@/lib/forecast-lab';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** A saved forecast run: what each method forecast, and how it turned out once the months were over. */
export default function ForecastRunPage() {
  const { org, orgId } = useOrg();
  const { runId } = useParams<{ runId: string }>();
  const q = useQuery({ queryKey: ['forecast-lab-run', orgId, runId], queryFn: () => api<LabRun>(`/v1/orgs/${orgId}/forecast-lab/runs/${runId}`) });
  if (!org) return null;
  const r = q.data;
  const label = Object.fromEntries((r?.meta.models ?? []).map((m) => [m.key, m.label]));
  return (
    <>
      <PageHeader
        title={r ? `Forecast run ${r.number}` : 'Forecast run'}
        description={r ? `Books up to ${monthName(r.baseMonth)}, methods checked on ${r.window} months. Saved ${dateTime(r.createdAt)}${r.createdBy ? ` by ${r.createdBy}` : ''}. Saved runs are never changed.` : undefined}
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/forecast-lab`}>Forecast lab</Link>}
      />
      <ErrorAlert title="Could not load the run" error={q.error} />
      {r ? (
        <div className="space-y-4">
          {r.note ? <p className="text-sm">“{r.note}”</p> : null}
          {r.meta.series.map((s) => {
            const fs = r.forecasts.filter((f) => f.series === s.key);
            const months = [...new Set(fs.map((f) => f.month))].sort();
            const result = r.results[s.key];
            const t = r.tracking.find((x) => x.series === s.key)!;
            const models = [...new Set(fs.map((f) => f.model))];
            return (
              <Card key={s.key}>
                <CardHeader title={s.label} description={result?.summary ?? ''} />
                <Table aria-label={`${s.label} forecasts`}>
                  <thead>
                    <tr>
                      <Th>Method</Th>
                      <Th numeric>Backtest error</Th>
                      {months.map((m) => <Th key={m} numeric>{monthName(m)}</Th>)}
                      <Th numeric>Error so far</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.length ? (
                      <tr>
                        <Td className="text-fg-muted">Actual</Td>
                        <Td />
                        {months.map((m) => {
                          const a = fs.find((f) => f.month === m)?.actual;
                          return <Td key={m} numeric className="font-medium">{a ? <Money value={a} currency={r.currency} signed /> : <span className="text-fg-muted">Not over yet</span>}</Td>;
                        })}
                        <Td />
                      </tr>
                    ) : null}
                    {models.map((model) => {
                      const tm = t.models.find((x) => x.model === model)!;
                      const back = result?.models.find((x) => x.model === model);
                      return (
                        <Tr key={model}>
                          <Td>
                            {label[model]} {model === result?.best ? <Badge tone="accent">Best in backtest</Badge> : null} {model === t.best ? <Badge tone="positive">Most accurate</Badge> : null}
                          </Td>
                          <Td numeric>{pct(back?.stats.wape ?? null)}</Td>
                          {months.map((m) => {
                            const f = fs.find((x) => x.model === model && x.month === m);
                            return <Td key={m} numeric>{f ? <Money value={f.value} currency={r.currency} signed /> : '—'}</Td>;
                          })}
                          <Td numeric>{tm.stats.count ? pct(tm.stats.wape) : '—'}</Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </Card>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Loading…</p>
      )}
    </>
  );
}
