'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { useAccounts, useOrg } from '@/lib/org';
import { can, type Account, type AccountType } from '@/lib/types';

const TYPE_LABEL: Record<AccountType, string> = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', EXPENSE: 'Expenses' };

interface Draft {
  id?: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  parentId: string;
  isPostable: boolean;
  isActive: boolean;
  description: string;
}

/** Depth-first order so children sit under their parent. */
function ordered(accounts: Account[]): { a: Account; depth: number }[] {
  const byParent = new Map<string | null, Account[]>();
  for (const a of accounts) {
    const k = a.parentId && accounts.some((p) => p.id === a.parentId) ? a.parentId : null;
    byParent.set(k, [...(byParent.get(k) ?? []), a]);
  }
  const out: { a: Account; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      out.push({ a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function AccountsPage() {
  const { org, orgId } = useOrg();
  const [showInactive, setShowInactive] = useState(false);
  const accounts = useAccounts(true);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const canManage = can(org?.role, 'accounts.manage');

  const rows = useMemo(() => ordered((accounts.data ?? []).filter((a) => showInactive || a.isActive)), [accounts.data, showInactive]);
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const common = { name: d.name, subtype: d.subtype || null, description: d.description || null, parentId: d.parentId || null, isPostable: d.isPostable };
      return d.id
        ? api<Account>(`/v1/orgs/${orgId}/accounts/${d.id}`, { method: 'PATCH', body: { ...common, code: d.code, isActive: d.isActive } })
        : api<Account>(`/v1/orgs/${orgId}/accounts`, { method: 'POST', body: { ...common, code: d.code, type: d.type, subtype: d.subtype || undefined, description: d.description || undefined } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['accounts', orgId] });
      setDraft(null);
    },
  });

  if (!org) return null;
  const parents = (accounts.data ?? []).filter((a) => !a.isPostable && draft && a.type === draft.type && a.id !== draft.id);

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Header accounts group others and cannot take postings. Accounts with postings cannot change code, become headers, or be deactivated with a balance."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-[var(--t2t-accent)]" /> Show inactive
            </label>
            {canManage ? (
              <Button onClick={() => { save.reset(); setDraft({ code: '', name: '', type: 'EXPENSE', subtype: '', parentId: '', isPostable: true, isActive: true, description: '' }); }}>
                New account
              </Button>
            ) : null}
          </>
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Subtype</Th>
              <Th>Status</Th>
              <Th><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, depth }) => (
              <Tr key={a.id}>
                <Td className="num text-fg-muted">{a.code}</Td>
                <Td>
                  <span style={{ paddingLeft: depth * 18 }} className={a.isPostable ? '' : 'font-semibold'}>
                    {a.name}
                  </span>
                </Td>
                <Td className="text-fg-muted">{TYPE_LABEL[a.type]}</Td>
                <Td className="text-xs text-fg-muted">{a.subtype?.replace(/_/g, ' ').toLowerCase() ?? ''}</Td>
                <Td>
                  {!a.isActive ? <Badge>Inactive</Badge> : !a.isPostable ? <Badge tone="violet">Header</Badge> : <Badge tone="positive">Active</Badge>}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {a.isPostable ? (
                    <Link className="mr-3 text-xs text-accent hover:underline" href={`/orgs/${orgId}/reports/general-ledger?accountId=${a.id}`}>Ledger</Link>
                  ) : null}
                  {canManage ? (
                    <Button variant="ghost" size="sm" onClick={() => { save.reset(); setDraft({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? '', parentId: a.parentId ?? '', isPostable: a.isPostable, isActive: a.isActive, description: a.description ?? '' }); }}>
                      Edit
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={draft?.id ? 'Edit account' : 'New account'}>
        {draft ? (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            {save.error ? <div className="sm:col-span-2"><Alert title="Could not save">{save.error instanceof ApiError ? save.error.message : 'Try again.'}</Alert></div> : null}
            <Field label="Code">{(p) => <Input {...p} required value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />}</Field>
            <Field label="Name">{(p) => <Input {...p} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
            <Field label="Type" hint={draft.id ? 'Type cannot change after creation.' : undefined}>
              {(p) => (
                <Select {...p} disabled={!!draft.id} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as AccountType, subtype: '', parentId: '' })}>
                  {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Subtype">
              {(p) => (
                <Select {...p} value={draft.subtype} onChange={(e) => setDraft({ ...draft, subtype: e.target.value })}>
                  <option value="">None</option>
                  {ACCOUNT_SUBTYPES[draft.type].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Parent (header) account">
              {(p) => (
                <Select {...p} value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}>
                  <option value="">None (top level)</option>
                  {parents.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Kind">
              {(p) => (
                <Select {...p} value={draft.isPostable ? 'post' : 'header'} onChange={(e) => setDraft({ ...draft, isPostable: e.target.value === 'post' })}>
                  <option value="post">Postable account</option>
                  <option value="header">Header (grouping only)</option>
                </Select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description">{(p) => <Input {...p} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}</Field>
            </div>
            {draft.id ? (
              <label className="flex items-center gap-2 text-sm text-fg-muted sm:col-span-2">
                <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} className="accent-[var(--t2t-accent)]" /> Active
              </label>
            ) : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="submit" loading={save.isPending}>Save account</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
