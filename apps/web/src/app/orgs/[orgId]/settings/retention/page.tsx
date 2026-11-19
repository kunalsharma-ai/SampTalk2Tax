'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Category = { key: string; title: string; what: string; minDays: number; maxDays: number; days: number | null };
type Overview = {
  canManage: boolean;
  statutory: { title: string; minimum: string; basis: string }[];
  categories: Category[];
  runs: { id: string; trigger: 'SCHEDULE' | 'MANUAL'; deleted: Record<string, number>; at: string }[];
};

/** Data retention policies (SEC-020). */
export default function RetentionPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/retention`;
  const q = useQuery({ queryKey: ['retention', orgId], queryFn: () => api<Overview>(base) });
  const set = useMutation({ mutationFn: (body: { category: string; days: number | null }) => api<Overview>(base, { method: 'PUT', body }), onSuccess: (o) => qc.setQueryData(['retention', orgId], o) });
  const run = useMutation({ mutationFn: () => api<Overview>(`${base}/run`, { method: 'POST' }), onSuccess: (o) => qc.setQueryData(['retention', orgId], o) });
  if (!org) return null;
  const o = q.data;
  const titles = new Map(o?.categories.map((c) => [c.key, c.title]));
  return (
    <>
      <PageHeader
        title="Data retention"
        description="How long Talk2Tax keeps your data. Accounting, tax and payroll records and the audit trail are never deleted on a schedule. Working data such as copilot conversations is kept until you choose a period; after that, anything older is deleted every day."
        actions={o?.canManage ? <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>Apply now</Button> : null}
      />
      <ErrorAlert title="Could not load data retention" error={q.error} />
      <ErrorAlert title="The period was not saved" error={set.error} />
      <ErrorAlert title="Could not apply the periods" error={run.error} />
      {o ? (
        <>
          <Card className="mb-4">
            <CardHeader title="Records kept by law" description="Never deleted on a schedule. If you stop using Talk2Tax, export them first: you must keep them for at least these periods." />
            <Table aria-label="Records kept by law">
              <thead><tr><Th>Records</Th><Th>Keep for</Th><Th>Basis</Th></tr></thead>
              <tbody>
                {o.statutory.map((s) => (
                  <Tr key={s.title}><Td>{s.title}</Td><Td>{s.minimum}</Td><Td className="text-sm text-fg-muted">{s.basis}</Td></Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card className="mb-4">
            <CardHeader title="Working data" description="Choose how long to keep each kind; Keep never deletes it. Deleted data cannot be brought back." />
            <Table aria-label="Working data">
              <thead><tr><Th>Data</Th><Th>Kept</Th><Th /></tr></thead>
              <tbody>
                {o.categories.map((c) => (
                  <PeriodRow key={`${c.key}-${c.days}`} c={c} manage={o.canManage} pending={set.isPending} onSave={(days) => set.mutate({ category: c.key, days })} />
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader title="Retention runs" description="Each run that deleted something, and each run started with Apply now." />
            {!o.runs.length ? <EmptyState title="Nothing deleted yet">Runs appear here once a period is set and something is older than it.</EmptyState> : (
              <Table aria-label="Retention runs">
                <thead><tr><Th>When</Th><Th>Started by</Th><Th>Deleted</Th></tr></thead>
                <tbody>
                  {o.runs.map((r) => (
                    <Tr key={r.id}>
                      <Td className="whitespace-nowrap">{dateTime(r.at)}</Td>
                      <Td>{r.trigger === 'MANUAL' ? <Badge tone="accent">Apply now</Badge> : <Badge tone="neutral">Daily run</Badge>}</Td>
                      <Td>{Object.entries(r.deleted).map(([k, n]) => `${titles.get(k) ?? k}: ${n}`).join(' · ')}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

function PeriodRow({ c, manage, pending, onSave }: { c: Category; manage: boolean; pending: boolean; onSave: (days: number | null) => void }) {
  const [mode, setMode] = useState<'keep' | 'days'>(c.days === null ? 'keep' : 'days');
  const [days, setDays] = useState(String(c.days ?? Math.max(c.minDays, 365)));
  const changed = mode === 'keep' ? c.days !== null : String(c.days) !== days;
  return (
    <Tr>
      <Td>
        <span className="font-medium">{c.title}</span>
        <span className="block text-xs text-fg-muted">{c.what}</span>
      </Td>
      <Td className="whitespace-nowrap">
        {manage ? (
          <div className="flex items-end gap-2">
            <Field label={`${c.title} kept`}>
              {(p) => (
                <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as 'keep' | 'days')} className="w-40">
                  <option value="keep">Keep</option>
                  <option value="days">Delete after</option>
                </Select>
              )}
            </Field>
            {mode === 'days' ? <Field label={`${c.title} days`}>{(p) => <Input {...p} type="number" min={c.minDays} max={c.maxDays} value={days} onChange={(e) => setDays(e.target.value)} className="w-28" />}</Field> : null}
          </div>
        ) : c.days === null ? 'Kept' : `${c.days} days`}
      </Td>
      <Td>{manage ? <Button size="sm" disabled={!changed} loading={pending} onClick={() => onSave(mode === 'keep' ? null : Number(days))}>Save</Button> : null}</Td>
    </Tr>
  );
}
