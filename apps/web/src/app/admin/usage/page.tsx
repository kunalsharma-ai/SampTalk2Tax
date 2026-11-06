'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Field, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { bytes, type Level } from '@/components/usage-meter';
import { api } from '@/lib/api';

interface Row { org: { id: string; name: string; countryCode: string; isDemo: boolean }; plan: { name: string; status: string } | null; ai: Level & { tokens: number }; uploads: Level & { bytes: number } }
interface PlatformUsage { month: string; months: string[]; totals: { aiCalls: number; tokens: number; uploads: number; bytes: number; atLimit: number; nearLimit: number }; organisations: Row[] }

const TONE = { UNLIMITED: 'neutral', OK: 'neutral', NEAR: 'warning', REACHED: 'negative' } as const;
const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const cell = (l: Level) => (
  <span className="whitespace-nowrap">
    <span className="font-mono tabular-nums">{l.used.toLocaleString('en-IN')}</span>
    <span className="text-fg-muted"> / {l.limit === null ? 'no limit' : l.limit.toLocaleString('en-IN')}</span>
    {l.state === 'NEAR' || l.state === 'REACHED' ? <Badge className="ml-2" tone={TONE[l.state]}>{l.percent}%</Badge> : null}
  </span>
);

/** AI requests and uploads per organisation in a month, against each plan. */
export default function AdminUsagePage() {
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin-usage', month], queryFn: () => api<PlatformUsage>(`/v1/admin/usage${month ? `?month=${month}` : ''}`) });
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Usage"
        description="AI requests and uploads by organisation, counted per calendar month (India time) against each plan's limits. The fullest organisations come first."
        actions={d ? (
          <Field label="Month">
            {(p) => (
              <Select {...p} className="w-48" value={month ?? d.month} onChange={(e) => setMonth(e.target.value)}>
                {d.months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </Select>
            )}
          </Field>
        ) : null}
      />
      {d ? (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="AI requests" value={d.totals.aiCalls.toLocaleString('en-IN')} sub={`${d.totals.tokens.toLocaleString('en-IN')} tokens`} />
            <Stat label="Uploads" value={d.totals.uploads.toLocaleString('en-IN')} sub={bytes(d.totals.bytes)} />
            <Stat label="At a limit" value={d.totals.atLimit} tone={d.totals.atLimit ? 'negative' : 'neutral'} />
            <Stat label="Nearly at a limit" value={d.totals.nearLimit} tone={d.totals.nearLimit ? 'warning' : 'neutral'} />
          </div>
          <Card aria-label="Usage by organisation">
            {d.organisations.length ? (
              <Table>
                <thead><tr><Th>Organisation</Th><Th>Plan</Th><Th>AI requests</Th><Th numeric>Tokens</Th><Th>Uploads</Th><Th numeric>Size</Th></tr></thead>
                <tbody>
                  {d.organisations.map((r) => (
                    <Tr key={r.org.id}>
                      <Td>{r.org.name}{r.org.isDemo ? <Badge className="ml-2" tone="warning">Demo</Badge> : null}<div className="text-xs text-fg-muted">{r.org.countryCode}</div></Td>
                      <Td className="text-sm">{r.plan ? `${r.plan.name} (${r.plan.status.toLowerCase()})` : '—'}</Td>
                      <Td>{cell(r.ai)}</Td>
                      <Td numeric>{r.ai.tokens.toLocaleString('en-IN')}</Td>
                      <Td>{cell(r.uploads)}</Td>
                      <Td numeric>{bytes(r.uploads.bytes)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="Nothing used this month">Organisations appear here once they use AI or upload files.</EmptyState>}
          </Card>
        </>
      ) : null}
    </>
  );
}
