'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { useExpenseOptions } from '@/components/expenses/claim-form';
import { can, type AllowanceKind, type AllowanceRate } from '@/lib/types';

const KIND = { MILEAGE: 'Mileage (per km)', PER_DIEM: 'Per diem (per day)' } as const;
const RATE = /^\d{0,9}(\.\d{0,4})?$/;

function issues(e: unknown) {
  return e instanceof ApiError && e.issues.length ? <ul className="mt-1 list-disc pl-5">{e.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null;
}

/** Mileage and per diem rates (EXP-006, EXP-008): what employees can claim instead of a receipt. */
export default function AllowanceRatesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const options = useExpenseOptions();
  const list = useQuery({ enabled: !!org, queryKey: ['allowance-rates', orgId], queryFn: () => api<AllowanceRate[]>(`/v1/orgs/${orgId}/expense-allowance-rates`) });
  const [form, setForm] = useState<{ kind: AllowanceKind; name: string; rate: string; accountId: string }>({ kind: 'MILEAGE', name: '', rate: '', accountId: '' });
  const [editing, setEditing] = useState<AllowanceRate | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['allowance-rates', orgId] });
    await qc.invalidateQueries({ queryKey: ['expense-options', orgId] });
  };
  const create = useMutation({
    mutationFn: () => api<AllowanceRate>(`/v1/orgs/${orgId}/expense-allowance-rates`, { method: 'POST', body: form }),
    onSuccess: async () => {
      setForm({ ...form, name: '', rate: '' });
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: (r: AllowanceRate) => api<AllowanceRate>(`/v1/orgs/${orgId}/expense-allowance-rates/${r.id}`, { method: 'PUT', body: { name: r.name, rate: r.rate, accountId: r.accountId, isActive: r.isActive } }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  if (!org) return null;
  const manage = can(org.role, 'expenses.reimburse');
  const accounts = options.data?.accounts ?? [];
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader title="Mileage and per diem rates" description="What employees can claim without a receipt: a distance driven for work at a rate per kilometre, or days away at a daily rate. The amount on the claim is worked out from the rate when the claim is saved; changing a rate later does not change claims already saved." />
      {manage ? (
        <Card className="mb-6">
          <CardHeader title="Add a rate" description="Name each rate so claimants can tell them apart, such as Car, Two-wheeler, Metro city or Other city. The account is where approved claims post the expense." />
          <form className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Kind">{(p) => <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AllowanceKind })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label="Name">{(p) => <Input {...p} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label={`Rate in ${c}`}>{(p) => <Input {...p} className="num text-right" inputMode="decimal" value={form.rate} onChange={(e) => RATE.test(e.target.value) && setForm({ ...form, rate: e.target.value })} />}</Field>
            <Field label="Expense account">
              {(p) => (
                <Select {...p} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">Choose…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            <div className="flex items-end"><Button type="submit" loading={create.isPending} disabled={!form.name.trim() || !form.rate || !form.accountId}>Add rate</Button></div>
            {create.error ? <div className="sm:col-span-2 lg:col-span-5"><Alert title="Rate not added">{create.error.message}{issues(create.error)}</Alert></div> : null}
          </form>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Rates" description={list.data?.length === 0 ? 'No rates yet. Until one is added, employees can only claim receipts.' : undefined} />
        {save.error ? <div className="px-5 pb-3"><Alert title="Rate not saved">{save.error.message}{issues(save.error)}</Alert></div> : null}
        <Table>
          <thead><tr><Th>Kind</Th><Th>Name</Th><Th numeric>Rate</Th><Th>Posts to</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {(list.data ?? []).map((r) =>
              editing?.id === r.id ? (
                <Tr key={r.id}>
                  <Td>{KIND[r.kind]}</Td>
                  <Td><Input aria-label="Name" maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Td>
                  <Td numeric><Input aria-label="Rate" className="num text-right" inputMode="decimal" value={editing.rate} onChange={(e) => RATE.test(e.target.value) && setEditing({ ...editing, rate: e.target.value })} /></Td>
                  <Td>
                    <Select aria-label="Expense account" value={editing.accountId} onChange={(e) => setEditing({ ...editing, accountId: e.target.value })}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                    </Select>
                  </Td>
                  <Td>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> Active</label>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button size="sm" loading={save.isPending} onClick={() => save.mutate(editing)}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </Td>
                </Tr>
              ) : (
                <Tr key={r.id}>
                  <Td>{KIND[r.kind]}</Td>
                  <Td className="font-medium">{r.name}</Td>
                  <Td numeric className="num">{money(r.rate, c)} / {r.unit === 'KM' ? 'km' : 'day'}</Td>
                  <Td className="text-fg-muted">{r.account ?? '—'}</Td>
                  <Td>{r.isActive ? <Badge tone="positive">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  <Td className="text-right">{manage ? <Button size="sm" variant="ghost" aria-label={`Change ${r.name}`} onClick={() => { save.reset(); setEditing(r); }}>Change</Button> : null}</Td>
                </Tr>
              ),
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
