'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { useExpenseOptions } from '@/components/expenses/claim-form';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can, type ExpenseCategory, type ExpenseCategoryReceipt } from '@/lib/types';

interface List {
  categories: ExpenseCategory[];
  usageDays: number | null;
}
const EMPTY = { name: '', description: '', accountId: '', taxRateId: '', receipt: 'POLICY' as ExpenseCategoryReceipt };

/** Expenses → Expense categories (EXP-005): the list employees claim under, each posting to one expense account. */
export default function ExpenseCategoriesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const manage = can(org?.role, 'expenses.reimburse');
  const q = useQuery({ queryKey: ['expense-categories', orgId, manage], queryFn: () => api<List>(`/v1/orgs/${orgId}/expense-categories${manage ? '?all=true' : ''}`) });
  const options = useExpenseOptions();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['expense-categories', orgId] }), qc.invalidateQueries({ queryKey: ['expense-options', orgId] })]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name, description: form.description || null, accountId: form.accountId, taxRateId: form.taxRateId || null, receipt: form.receipt };
      return editing ? api<ExpenseCategory>(`/v1/orgs/${orgId}/expense-categories/${editing}`, { method: 'PUT', body }) : api<ExpenseCategory>(`/v1/orgs/${orgId}/expense-categories`, { method: 'POST', body });
    },
    onSuccess: async () => {
      setEditing(null);
      setForm(EMPTY);
      await refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (c: ExpenseCategory) => api<ExpenseCategory>(`/v1/orgs/${orgId}/expense-categories/${c.id}/${c.isActive ? 'archive' : 'restore'}`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  if (!org) return null;
  const list = q.data?.categories ?? [];
  const active = list.filter((c) => c.isActive);
  const archived = list.filter((c) => !c.isActive);
  const edit = (c: ExpenseCategory) => {
    setEditing(c.id);
    setForm({ name: c.name, description: c.description ?? '', accountId: c.accountId, taxRateId: c.taxRateId ?? '', receipt: c.receipt });
  };
  const seeUse = q.data?.usageDays != null;
  const row = (c: ExpenseCategory) => (
    <Tr key={c.id}>
      <Td className="align-top">
        <span className="font-medium">{c.name}</span>
        {c.description ? <span className="block max-w-sm text-xs text-fg-muted">{c.description}</span> : null}
      </Td>
      <Td className="align-top text-fg-muted">{c.account ?? '—'}{c.taxRate ? <span className="block text-xs">Tax: {c.taxRate}</span> : null}</Td>
      <Td className="align-top">{c.receipt === 'ALWAYS' ? <Badge tone="warning">Always required</Badge> : <span className="text-xs text-fg-muted">As the expense policy says</span>}</Td>
      <Td className="align-top">
        {c.limits?.length ? <ul className="text-xs text-fg-muted">{c.limits.map((l) => <li key={l.id}>{l.summary}{l.severity === 'BLOCK' ? ' (blocks)' : ''}</li>)}</ul> : <span className="text-xs text-fg-faint">None</span>}
      </Td>
      {seeUse ? <Td numeric className="align-top">{c.usage ? <><Money value={c.usage.total} currency={org.functionalCurrency} /><span className="block text-xs text-fg-muted">{c.usage.lines} {c.usage.lines === 1 ? 'line' : 'lines'}</span></> : '—'}</Td> : null}
      {manage ? (
        <Td className="align-top whitespace-nowrap">
          {c.isActive ? <Button size="sm" variant="secondary" aria-label={`Edit ${c.name}`} onClick={() => edit(c)}>Edit</Button> : null}{' '}
          <Button size="sm" variant="ghost" aria-label={`${c.isActive ? 'Archive' : 'Restore'} ${c.name}`} loading={toggle.isPending && toggle.variables?.id === c.id} onClick={() => toggle.mutate(c)}>{c.isActive ? 'Archive' : 'Restore'}</Button>
        </Td>
      ) : null}
    </Tr>
  );
  const head = (
    <thead>
      <Tr><Th>Category</Th><Th>Posts to</Th><Th>Receipt</Th><Th>Limits</Th>{seeUse ? <Th numeric>Claimed, last {q.data?.usageDays} days</Th> : null}{manage ? <Th /> : null}</Tr>
    </thead>
  );
  return (
    <>
      <PageHeader
        title="Expense categories"
        description="The categories people claim expenses under. Each posts to one expense account, so employees never need the chart of accounts. Limits per category are set in the expense policy on the category's account."
        actions={can(org.role, 'expenses.read') ? <Link href={`/orgs/${orgId}/expenses/policy`}><Button variant="secondary">Expense policy</Button></Link> : null}
      />
      <ErrorAlert title="Could not load expense categories" error={q.error} />
      {q.data ? (
        <Card role="region" aria-label="Categories in use">
          <CardHeader title="Categories in use" description="What employees pick from on a claim line, with the guidance they see." />
          {active.length ? (
            <Table aria-label="Categories in use">{head}<tbody>{active.map(row)}</tbody></Table>
          ) : (
            <EmptyState title="No categories yet">Until there are categories, people claim to an expense account directly.</EmptyState>
          )}
        </Card>
      ) : null}
      {manage ? (
        <Card className="mt-6" role="region" aria-label={editing ? 'Edit category' : 'Add a category'}>
          <CardHeader title={editing ? 'Edit category' : 'Add a category'} description="Claims already approved keep their account. Drafts in this category are saved again to the new account before they can be submitted." />
          <form
            className="grid gap-4 px-5 pb-5 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field label="Name">{(p) => <Input {...p} maxLength={60} placeholder="e.g. Hotels" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Posts to">
              {(p) => (
                <Select {...p} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">Choose an expense account…</option>
                  {(options.data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Guidance for employees" hint="What belongs here, shown when they pick it.">{(p) => <Input {...p} maxLength={500} placeholder="Optional" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Field label="Default tax">
              {(p) => (
                <Select {...p} value={form.taxRateId} onChange={(e) => setForm({ ...form, taxRateId: e.target.value })}>
                  <option value="">No tax</option>
                  {(options.data?.taxRates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Receipt">
              {(p) => (
                <Select {...p} value={form.receipt} onChange={(e) => setForm({ ...form, receipt: e.target.value as ExpenseCategoryReceipt })}>
                  <option value="POLICY">As the expense policy says</option>
                  <option value="ALWAYS">Always required: no submitting without one</option>
                </Select>
              )}
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit" loading={save.isPending} disabled={!form.name.trim() || !form.accountId}>{editing ? 'Save category' : 'Add category'}</Button>
              {editing ? <Button type="button" variant="ghost" onClick={() => { setEditing(null); setForm(EMPTY); }}>Cancel</Button> : null}
            </div>
            {save.error ? (
              <div className="sm:col-span-2">
                <Alert tone="negative" title="Could not save the category">
                  {save.error.message}
                  {save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-disc pl-5">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
                </Alert>
              </div>
            ) : null}
          </form>
        </Card>
      ) : null}
      {toggle.error ? <div className="mt-4"><Alert tone="negative" title="Could not change the category">{toggle.error instanceof ApiError && toggle.error.issues.length ? toggle.error.issues.join('. ') : toggle.error.message}</Alert></div> : null}
      {manage && archived.length ? (
        <Card className="mt-6" role="region" aria-label="Archived categories">
          <CardHeader title="Archived categories" description="No longer offered on new claim lines; lines already claimed keep the name." />
          <Table aria-label="Archived categories">{head}<tbody>{archived.map(row)}</tbody></Table>
        </Card>
      ) : null}
    </>
  );
}
