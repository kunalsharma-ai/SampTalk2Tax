'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { METHODS, type Sample, type SampleSummary } from '@/components/controls/samples';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface List {
  samples: SampleSummary[];
  populations: Record<SampleSummary['population'], string>;
}

/** Audit sampling (AUDIT-009): draw samples of transactions to test, from a seed anyone can draw again. */
export default function AuditSamplesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({ queryKey: ['audit-samples', orgId], queryFn: () => api<List>(`/v1/orgs/${orgId}/audit-samples`) });
  const t = today();
  const [form, setForm] = useState({ name: '', population: 'JOURNALS', from: `${t.slice(0, 7)}-01`, to: t, method: 'RANDOM', size: '25', threshold: '', seed: '' });
  const draw = useMutation({
    mutationFn: () =>
      api<Sample>(`/v1/orgs/${orgId}/audit-samples`, {
        method: 'POST',
        body: { name: form.name, population: form.population, from: form.from, to: form.to, method: form.method, size: Number(form.size), ...(form.method === 'HIGH_VALUE' ? { threshold: form.threshold } : {}), ...(form.seed.trim() ? { seed: form.seed.trim() } : {}) },
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['audit-samples', orgId] });
      router.push(`/orgs/${orgId}/audit-samples/${s.id}`);
    },
  });
  if (!org) return null;
  const d = q.data;
  const size = Number(form.size);
  const ready = form.name.trim() && form.from && form.to && Number.isInteger(size) && size >= 1 && size <= 200 && (form.method !== 'HIGH_VALUE' || /^\d+(\.\d{1,2})?$/.test(form.threshold));
  return (
    <>
      <PageHeader title="Audit samples" description="Pick transactions to test from a period's posted books. Each sample keeps its seed, so anyone can draw it again and see it was not hand-picked." />
      <ErrorAlert title="Could not load" error={q.error} />
      {d ? (
        <>
          <Card className="mb-4">
            <CardHeader title="Samples drawn" description="Newest first, with how far testing has got" />
            {!d.samples.length ? (
              <EmptyState title="No samples yet">Draw one below.</EmptyState>
            ) : (
              <Table aria-label="Audit samples">
                <thead><Tr><Th>Ref</Th><Th>Sample</Th><Th>Method</Th><Th>Population</Th><Th>Tested</Th><Th>Status</Th></Tr></thead>
                <tbody>
                  {d.samples.map((s) => (
                    <Tr key={s.id}>
                      <Td className="num">{s.reference}</Td>
                      <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/audit-samples/${s.id}`}>{s.name}</Link><div className="text-xs text-fg-muted">{s.populationLabel}, {date(s.from)} to {date(s.to)}</div></Td>
                      <Td>{METHODS[s.method].label}</Td>
                      <Td className="text-sm">{s.populationCount} items, {money(s.populationTotal, org.functionalCurrency)}</Td>
                      <Td className="text-sm">{s.progress.tested} of {s.progress.tested + s.progress.remaining}{s.progress.exceptions ? <div><Badge tone="negative">{s.progress.exceptions} {s.progress.exceptions === 1 ? 'exception' : 'exceptions'}</Badge></div> : null}</Td>
                      <Td><Badge tone={s.status === 'COMPLETED' ? 'positive' : 'warning'}>{s.status === 'COMPLETED' ? 'Completed' : 'Testing'}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Draw a sample" description="Only posted items dated in the range are in the population. Amounts are in the organisation's currency." />
            <form
              className="flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                draw.mutate();
              }}
            >
              <Field label="Sample name">{(p) => <Input {...p} maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Such as Q2 journals" />}</Field>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Population">{(p) => <Select {...p} value={form.population} onChange={(e) => setForm({ ...form, population: e.target.value })}>{Object.entries(d.populations).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                <Field label="From">{(p) => <Input {...p} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
                <Field label="To">{(p) => <Input {...p} type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
                <Field label="Items to pick" hint="1 to 200">{(p) => <Input {...p} inputMode="numeric" value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} />}</Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Method" hint={METHODS[form.method as SampleSummary['method']].hint}>{(p) => <Select {...p} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}</Field>
                {form.method === 'HIGH_VALUE' ? <Field label="Threshold" hint="Every item at or above this is tested">{(p) => <Input {...p} inputMode="decimal" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} placeholder="50000" />}</Field> : null}
                <Field label="Seed" hint="Blank: a new random seed">{(p) => <Input {...p} maxLength={80} value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />}</Field>
              </div>
              <div><Button type="submit" size="sm" disabled={!ready} loading={draw.isPending}>Draw sample</Button></div>
              <ErrorAlert title="The sample was not drawn" error={draw.error} />
            </form>
          </Card>
        </>
      ) : null}
    </>
  );
}
