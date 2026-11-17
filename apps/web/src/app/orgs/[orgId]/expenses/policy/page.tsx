'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { useExpenseOptions } from '@/components/expenses/claim-form';
import { can, type ExpensePolicyKind, type ExpensePolicyRule, type PolicySeverity } from '@/lib/types';

const KIND: Record<ExpensePolicyKind, string> = {
  LINE_MAX: 'Limit per receipt',
  DAILY_MAX: 'Limit per day',
  MONTHLY_MAX: 'Limit per calendar month',
  CLAIM_MAX: 'Limit per claim',
  RECEIPT_ABOVE: 'Receipts required',
  MAX_AGE_DAYS: 'Receipt age (days)',
};
const WITH_CATEGORY: ExpensePolicyKind[] = ['LINE_MAX', 'DAILY_MAX', 'MONTHLY_MAX'];
const AMOUNT = /^\d{0,12}(\.\d{0,2})?$/;

function issues(e: unknown) {
  return e instanceof ApiError && e.issues.length ? <ul className="mt-1 list-disc pl-5">{e.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null;
}

interface Draft {
  kind: ExpensePolicyKind;
  severity: PolicySeverity;
  accountId: string;
  value: string;
}

const body = (d: Omit<Draft, 'kind'> & { kind: ExpensePolicyKind }) => ({
  severity: d.severity,
  accountId: WITH_CATEGORY.includes(d.kind) && d.accountId ? d.accountId : null,
  amount: d.kind === 'MAX_AGE_DAYS' ? null : d.value,
  days: d.kind === 'MAX_AGE_DAYS' ? Number(d.value) : null,
});

/** Expense policy (EXP-013, EXP-015, EXP-022): spending limits and the other rules every claim is checked against. */
export default function ExpensePolicyPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const options = useExpenseOptions();
  const list = useQuery({ enabled: !!org, queryKey: ['expense-policy', orgId], queryFn: () => api<ExpensePolicyRule[]>(`/v1/orgs/${orgId}/expense-policy-rules`) });
  const [form, setForm] = useState<Draft>({ kind: 'LINE_MAX', severity: 'WARN', accountId: '', value: '' });
  const [editing, setEditing] = useState<(Draft & { id: string; isActive: boolean }) | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['expense-policy', orgId] });
    await qc.invalidateQueries({ queryKey: ['expense-options', orgId] });
  };
  const create = useMutation({
    mutationFn: () => api<ExpensePolicyRule>(`/v1/orgs/${orgId}/expense-policy-rules`, { method: 'POST', body: { kind: form.kind, ...body(form) } }),
    onSuccess: async () => {
      setForm({ ...form, value: '' });
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: (d: Draft & { id: string; isActive: boolean }) => api<ExpensePolicyRule>(`/v1/orgs/${orgId}/expense-policy-rules/${d.id}`, { method: 'PUT', body: { ...body(d), isActive: d.isActive } }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  if (!org) return null;
  const manage = can(org.role, 'expenses.reimburse');
  const accounts = options.data?.accounts ?? [];
  const c = org.functionalCurrency;
  const days = form.kind === 'MAX_AGE_DAYS';
  return (
    <>
      <PageHeader
        title="Expense policy"
        description="Spending limits and other rules every expense claim is checked against. A rule that blocks stops the claim being submitted until it is fixed; a rule that warns lets it through, but the approver must say why they approve it anyway. Limits per day and per month add up the claimant's other submitted and approved claims too."
      />
      {manage ? (
        <Card className="mb-6">
          <CardHeader title="Add a rule" description="Limits per receipt, per day and per month can apply to one category or to everything. Amounts are in the organisation's currency." />
          <form className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Rule">{(p) => <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ExpensePolicyKind, value: '' })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label={days ? 'Days' : `Amount in ${c}`}>
              {(p) => <Input {...p} className="num text-right" inputMode={days ? 'numeric' : 'decimal'} value={form.value} onChange={(e) => (days ? /^\d{0,4}$/ : AMOUNT).test(e.target.value) && setForm({ ...form, value: e.target.value })} />}
            </Field>
            <Field label="Category">
              {(p) => (
                <Select {...p} disabled={!WITH_CATEGORY.includes(form.kind)} value={WITH_CATEGORY.includes(form.kind) ? form.accountId : ''} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">Every category</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="When broken">
              {(p) => (
                <Select {...p} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as PolicySeverity })}>
                  <option value="WARN">Warn the approver</option>
                  <option value="BLOCK">Block submission</option>
                </Select>
              )}
            </Field>
            <div className="flex items-end"><Button type="submit" loading={create.isPending} disabled={!form.value}>Add rule</Button></div>
            {create.error ? <div className="sm:col-span-2 lg:col-span-5"><Alert title="Rule not added">{create.error.message}{issues(create.error)}</Alert></div> : null}
          </form>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Policy rules" description={list.data?.length === 0 ? 'No rules yet. Claims are only checked for possible duplicates until a rule is added.' : undefined} />
        {save.error ? <div className="px-5 pb-3"><Alert title="Rule not saved">{save.error.message}{issues(save.error)}</Alert></div> : null}
        <Table>
          <thead><tr><Th>Rule</Th><Th>When broken</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {(list.data ?? []).map((r) =>
              editing?.id === r.id ? (
                <Tr key={r.id}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-fg-muted">{KIND[r.kind]}</span>
                      <Input aria-label={r.kind === 'MAX_AGE_DAYS' ? 'Days' : 'Amount'} className="num w-32 text-right" value={editing.value} onChange={(e) => (r.kind === 'MAX_AGE_DAYS' ? /^\d{0,4}$/ : AMOUNT).test(e.target.value) && setEditing({ ...editing, value: e.target.value })} />
                      {WITH_CATEGORY.includes(r.kind) ? (
                        <Select aria-label="Category" value={editing.accountId} onChange={(e) => setEditing({ ...editing, accountId: e.target.value })}>
                          <option value="">Every category</option>
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                        </Select>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <Select aria-label="When broken" value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value as PolicySeverity })}>
                      <option value="WARN">Warn the approver</option>
                      <option value="BLOCK">Block submission</option>
                    </Select>
                  </Td>
                  <Td><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> Active</label></Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button size="sm" loading={save.isPending} onClick={() => save.mutate(editing)}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </Td>
                </Tr>
              ) : (
                <Tr key={r.id}>
                  <Td className="font-medium">{r.summary}</Td>
                  <Td>{r.severity === 'BLOCK' ? <Badge tone="negative">Blocks submission</Badge> : <Badge tone="warning">Warns the approver</Badge>}</Td>
                  <Td>{r.isActive ? <Badge tone="positive">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  <Td className="text-right">
                    {manage ? (
                      <Button size="sm" variant="ghost" aria-label={`Change ${r.summary}`} onClick={() => { save.reset(); setEditing({ id: r.id, kind: r.kind, severity: r.severity, accountId: r.accountId ?? '', value: r.kind === 'MAX_AGE_DAYS' ? String(r.days) : r.amount!, isActive: r.isActive }); }}>
                        Change
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ),
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
