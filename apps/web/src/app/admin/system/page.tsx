'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { PageHeader } from '@/components/shell';
import { bytes } from '@/components/usage-meter';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { duration, Runner, SystemHealth } from '@/lib/operations';

const STATUS = { OK: { label: 'Healthy', tone: 'positive' }, DEGRADED: { label: 'Needs attention', tone: 'warning' }, DOWN: { label: 'Down', tone: 'negative' } } as const;
const RUNNER: Record<Runner['state'], { label: string; tone: 'positive' | 'neutral' | 'warning' | 'negative' }> = {
  OK: { label: 'Running', tone: 'positive' },
  WAITING: { label: 'Not run yet', tone: 'neutral' },
  OFF: { label: 'Switched off', tone: 'neutral' },
  FAILING: { label: 'Failing', tone: 'negative' },
  LATE: { label: 'Late', tone: 'warning' },
};
const ms = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })} ms`);
const every = (s: number) => (s === 0 ? 'off' : s < 60 ? `every ${s} s` : s < 3600 ? `every ${Math.round(s / 60)} min` : `every ${Math.round(s / 3600)} h`);

/** The API server, the database, the background runners and request timings, measured now. */
export default function SystemHealthPage() {
  const q = useQuery({ queryKey: ['admin-system'], queryFn: () => api<SystemHealth>('/v1/admin/system'), refetchInterval: 15_000 });
  const d = q.data;
  const peak = d ? Math.max(1, ...d.requests.minutes.map((m) => m.requests)) : 1;
  return (
    <>
      <PageHeader
        title="System health"
        description="Measured each time this page refreshes (every 15 seconds). Request timings and runners are for the API server answering this page, over the last 15 minutes."
        actions={d ? <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge> : null}
      />
      {d?.problems.length ? (
        <div className="mb-6"><Alert tone={d.status === 'DOWN' ? 'negative' : 'warning'} title="Needs attention"><ul className="list-disc pl-5">{d.problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert></div>
      ) : null}
      {d ? (
        <>
          <section aria-label="Summary" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Database" value={d.database.latencyMs === null ? 'Down' : ms(d.database.latencyMs)} sub={d.database.status === 'DOWN' ? d.database.error : `${d.database.connections} of ${d.database.maxConnections} connections · ${d.database.sizeBytes !== null ? bytes(d.database.sizeBytes) : ''}`} tone={d.database.status === 'OK' ? 'positive' : d.database.status === 'SLOW' ? 'warning' : 'negative'} />
            <Stat label="Requests (15 min)" value={d.requests.totals.requests.toLocaleString('en-IN')} sub={`p95 ${ms(d.requests.totals.p95Ms)} · p50 ${ms(d.requests.totals.p50Ms)}`} tone="accent" />
            <Stat label="Server errors (15 min)" value={d.requests.totals.serverErrors.toLocaleString('en-IN')} sub={`${d.requests.totals.clientErrors.toLocaleString('en-IN')} refused or invalid requests (4xx)`} tone={d.requests.totals.serverErrors ? 'negative' : 'neutral'} />
            <Stat label="Open error groups" value={d.errors.open ?? '—'} sub={<Link className="text-accent hover:underline" href="/admin/errors">{d.errors.lastHour ?? 0} in the last hour</Link>} tone={d.errors.open ? 'warning' : 'neutral'} />
          </section>

          <Card className="mb-6" aria-label="Requests per minute">
            <CardHeader title="Requests per minute" description="Bar height is the number of requests; red is the share that failed on the server." />
            <div className="flex h-28 items-end gap-1 px-5 pb-2 pt-4" role="img" aria-label={`Requests per minute over the last ${d.requests.windowMinutes} minutes`}>
              {d.requests.minutes.map((m) => (
                <div key={m.at} className="flex flex-1 flex-col justify-end" title={`${new Date(m.at).toLocaleTimeString()} · ${m.requests} requests · p95 ${ms(m.p95Ms)}`}>
                  <div className="rounded-t bg-negative" style={{ height: `${(m.serverErrors / peak) * 96}px` }} />
                  <div className="rounded-t bg-accent/70" style={{ height: `${((m.requests - m.serverErrors) / peak) * 96}px`, minHeight: m.requests ? 2 : 0 }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between px-5 pb-4 text-[11px] text-fg-faint"><span>{d.requests.windowMinutes} min ago</span><span>now</span></div>
          </Card>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card aria-label="API server">
              <CardHeader title="API server" />
              <dl className="grid grid-cols-[10rem_1fr] gap-y-2 px-5 pb-5 pt-3 text-sm">
                <dt className="text-fg-muted">Version</dt><dd className="font-mono">{d.server.version}{d.server.commit ? ` (${d.server.commit.slice(0, 7)})` : ''}</dd>
                <dt className="text-fg-muted">Environment</dt><dd>{d.server.environment} · region {d.server.region}</dd>
                <dt className="text-fg-muted">Running for</dt><dd>{duration(d.server.uptimeSeconds)} (since {dateTime(d.server.startedAt)})</dd>
                <dt className="text-fg-muted">Node.js</dt><dd className="font-mono">{d.server.node}</dd>
                <dt className="text-fg-muted">Memory</dt><dd>{bytes(d.server.memory.rssBytes)} in use · heap {bytes(d.server.memory.heapUsedBytes)} of {bytes(d.server.memory.heapTotalBytes)}</dd>
                <dt className="text-fg-muted">Load (1, 5, 15 min)</dt><dd className="font-mono">{d.server.loadAverage.join(' · ')}</dd>
              </dl>
            </Card>
            <Card aria-label="Database">
              <CardHeader title="Database" />
              <dl className="grid grid-cols-[10rem_1fr] gap-y-2 px-5 pb-5 pt-3 text-sm">
                <dt className="text-fg-muted">Answers in</dt><dd>{ms(d.database.latencyMs)}</dd>
                <dt className="text-fg-muted">PostgreSQL</dt><dd className="font-mono">{d.database.postgres ?? '—'}</dd>
                <dt className="text-fg-muted">Size</dt><dd>{d.database.sizeBytes !== null ? bytes(d.database.sizeBytes) : '—'}</dd>
                <dt className="text-fg-muted">Connections</dt><dd>{d.database.connections ?? '—'} of {d.database.maxConnections ?? '—'}</dd>
                <dt className="text-fg-muted">Last migration</dt><dd className="break-all font-mono text-xs">{d.database.lastMigration ? `${d.database.lastMigration.name}${d.database.lastMigration.at ? ` · ${dateTime(d.database.lastMigration.at)}` : ''}` : '—'}</dd>
              </dl>
            </Card>
          </div>

          <Card className="mb-6" aria-label="Background runners">
            <CardHeader title="Background runners" description="Passes are skipped while maintenance is in progress." />
            <Table>
              <thead><tr><Th>Runner</Th><Th>State</Th><Th>Runs</Th><Th>Last pass</Th><Th>Took</Th><Th>Failures</Th><Th>Skipped</Th></tr></thead>
              <tbody>
                {d.runners.map((r) => (
                  <Tr key={r.name}>
                    <Td>{r.name}<span className="block text-xs text-fg-muted">{every(r.intervalSeconds)}</span></Td>
                    <Td><Badge tone={RUNNER[r.state].tone}>{RUNNER[r.state].label}</Badge>{r.lastError ? <span className="mt-1 block max-w-xs text-xs text-negative">{r.lastError}</span> : null}</Td>
                    <Td className="font-mono tabular-nums">{r.runs}</Td>
                    <Td className="whitespace-nowrap text-sm">{r.lastFinishedAt ? dateTime(r.lastFinishedAt) : '—'}</Td>
                    <Td className="font-mono tabular-nums">{ms(r.lastMs)}</Td>
                    <Td className="font-mono tabular-nums">{r.failures}</Td>
                    <Td className="font-mono tabular-nums">{r.skipped}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card aria-label="Routes">
            <CardHeader title="Routes" description="The 50 routes with the most server errors, then the slowest. Ids in paths are replaced, so each row is one route for every organisation." />
            <Table>
              <thead><tr><Th>Route</Th><Th className="text-right">Requests</Th><Th className="text-right">4xx</Th><Th className="text-right">5xx</Th><Th className="text-right">p50</Th><Th className="text-right">p95</Th></tr></thead>
              <tbody>
                {d.requests.routes.map((r) => (
                  <Tr key={r.route}>
                    <Td className="font-mono text-xs">{r.route}</Td>
                    <Td className="text-right font-mono tabular-nums">{r.requests}</Td>
                    <Td className="text-right font-mono tabular-nums">{r.clientErrors}</Td>
                    <Td className={r.serverErrors ? 'text-right font-mono tabular-nums text-negative' : 'text-right font-mono tabular-nums'}>{r.serverErrors}</Td>
                    <Td className="text-right font-mono tabular-nums">{ms(r.p50Ms)}</Td>
                    <Td className="text-right font-mono tabular-nums">{ms(r.p95Ms)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : q.isError ? <Alert title="System health could not be read">{(q.error as Error).message}</Alert> : <p className="text-sm text-fg-muted">Measuring…</p>}
    </>
  );
}
