'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useMeWithRole } from '@/lib/admin';

interface Plan {
  code: string;
  name: string;
  description: string;
  prices: { INR: { monthly: string; annual: string }; USD: { monthly: string; annual: string } };
  limits: { members: number | null; aiCreditsPerMonth: number | null; documentUploadsPerMonth: number | null };
  features: string[];
  isActive: boolean;
  sortOrder: number;
  subscriptions?: number;
}
const FEATURES: [string, string][] = [['AI', 'AI assistant and agents'], ['PAYROLL', 'Payroll'], ['MULTI_CURRENCY', 'Foreign currencies'], ['CONSOLIDATION', 'Group consolidation']];
const LIMITS: [keyof Plan['limits'], string][] = [['members', 'Members'], ['aiCreditsPerMonth', 'AI requests a month'], ['documentUploadsPerMonth', 'Uploads a month']];
const blank: Plan = { code: '', name: '', description: '', prices: { INR: { monthly: '', annual: '' }, USD: { monthly: '', annual: '' } }, limits: { members: null, aiCreditsPerMonth: null, documentUploadsPerMonth: null }, features: [], isActive: true, sortOrder: 10 };

export default function AdminPlansPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [edit, setEdit] = useState<Plan | null>(null);
  const [isNew, setIsNew] = useState(false);
  const list = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<Plan[]>('/v1/admin/plans') });
  const save = useMutation({
    mutationFn: (p: Plan) => api<Plan>(`/v1/admin/plans/${p.code}`, { method: 'PUT', body: { name: p.name, description: p.description, prices: p.prices, limits: p.limits, features: p.features, isActive: p.isActive, sortOrder: p.sortOrder } }),
    onSuccess: async () => { setEdit(null); await qc.invalidateQueries({ queryKey: ['admin-plans'] }); },
  });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const price = (c: 'INR' | 'USD', k: 'monthly' | 'annual') => (
    <Field label={`${c} ${k}`}>{(p) => <Input {...p} className="w-28 num" inputMode="decimal" value={edit!.prices[c][k]} onChange={(e) => setEdit({ ...edit!, prices: { ...edit!.prices, [c]: { ...edit!.prices[c], [k]: e.target.value } } })} />}</Field>
  );
  return (
    <>
      <PageHeader
        title="Plans"
        description="What organisations can subscribe to: prices in rupees (India) and US dollars (elsewhere), limits and modules. Changes apply to new activations and renewals; an organisation keeps the price it activated at until then. The starting prices are the proposed launch prices, not final."
        actions={manage ? <Button variant="secondary" onClick={() => { setEdit({ ...blank }); setIsNew(true); save.reset(); }}>New plan</Button> : null}
      />
      <ErrorAlert title="Could not load plans" error={list.error} />
      {edit ? (
        <Card className="mb-6" aria-label="Edit plan">
          <CardHeader title={isNew ? 'New plan' : `Edit ${edit.name}`} description="Leave a limit empty for no limit." />
          <form className="space-y-4 px-5 pb-5 pt-4" onSubmit={(e) => { e.preventDefault(); save.mutate(edit); }}>
            <div className="flex flex-wrap items-end gap-3">
              {isNew ? <Field label="Code">{(p) => <Input {...p} className="w-40 uppercase" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} />}</Field> : null}
              <Field label="Name">{(p) => <Input {...p} className="w-48" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
              <Field label="Description">{(p) => <Input {...p} className="w-[28rem]" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />}</Field>
              <Field label="Order">{(p) => <Input {...p} className="w-20 num" inputMode="numeric" value={String(edit.sortOrder)} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) || 0 })} />}</Field>
            </div>
            <div className="flex flex-wrap items-end gap-3">{price('INR', 'monthly')}{price('INR', 'annual')}{price('USD', 'monthly')}{price('USD', 'annual')}</div>
            <div className="flex flex-wrap items-end gap-3">
              {LIMITS.map(([k, label]) => (
                <Field key={k} label={label}>{(p) => <Input {...p} className="w-36 num" inputMode="numeric" placeholder="No limit" value={edit.limits[k] === null ? '' : String(edit.limits[k])} onChange={(e) => setEdit({ ...edit, limits: { ...edit.limits, [k]: e.target.value.trim() === '' ? null : Number(e.target.value) } })} />}</Field>
              ))}
            </div>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Modules</legend>
              {FEATURES.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={edit.features.includes(k)} onChange={(e) => setEdit({ ...edit, features: e.target.checked ? [...edit.features, k] : edit.features.filter((f) => f !== k) })} />{label}</label>
              ))}
              <label className="flex items-center gap-2"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} />Offered to organisations</label>
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit" loading={save.isPending}>Save plan</Button>
              <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            </div>
            <ErrorAlert title="Plan not saved" error={save.error} />
          </form>
        </Card>
      ) : null}
      <Card aria-label="All plans">
        <Table>
          <thead><tr><Th>Plan</Th><Th numeric>India (₹/month · year)</Th><Th numeric>Elsewhere ($/month · year)</Th><Th>Limits</Th><Th>Modules</Th><Th numeric>Organisations</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {(list.data ?? []).map((p) => (
              <Tr key={p.code}>
                <Td><span className="font-medium">{p.name}</span> <span className="num text-xs text-fg-faint">{p.code}</span> {p.isActive ? null : <Badge tone="neutral">Not offered</Badge>}<span className="block text-xs text-fg-muted">{p.description}</span></Td>
                <Td numeric className="num whitespace-nowrap">{p.prices.INR.monthly} · {p.prices.INR.annual}</Td>
                <Td numeric className="num whitespace-nowrap">{p.prices.USD.monthly} · {p.prices.USD.annual}</Td>
                <Td className="text-sm">{LIMITS.map(([k, label]) => `${label}: ${p.limits[k] ?? 'no limit'}`).join(' · ')}</Td>
                <Td className="text-sm">{p.features.length ? p.features.join(', ') : '—'}</Td>
                <Td numeric>{p.subscriptions}</Td>
                <Td className="text-right">{manage ? <Button variant="ghost" size="sm" aria-label={`Edit ${p.name}`} onClick={() => { setEdit(p); setIsNew(false); save.reset(); }}>Edit</Button> : null}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
