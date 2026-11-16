'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { useAccounts, useOrg, useTaxRates } from '@/lib/org';
import { can, type TaxRate } from '@/lib/types';

interface Draft {
  id?: string;
  name: string;
  rate: string;
  salesAccountId: string;
  purchaseAccountId: string;
  isActive: boolean;
}

export default function TaxRatesPage() {
  const { org, orgId } = useOrg();
  const rates = useTaxRates(true);
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id
        ? api<TaxRate>(`/v1/orgs/${orgId}/tax-rates/${d.id}`, { method: 'PATCH', body: { name: d.name, isActive: d.isActive, salesAccountId: d.salesAccountId || null, purchaseAccountId: d.purchaseAccountId || null } })
        : api<TaxRate>(`/v1/orgs/${orgId}/tax-rates`, { method: 'POST', body: { name: d.name, rate: d.rate, salesAccountId: d.salesAccountId || null, purchaseAccountId: d.purchaseAccountId || null } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tax-rates', orgId] });
      setDraft(null);
    },
  });
  if (!org) return null;
  const control = new Set([org.arAccountId, org.apAccountId]);
  const liability = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id) && a.type === 'LIABILITY');
  const asset = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id) && a.type === 'ASSET');
  const name = (id: string | null) => (accounts.data ?? []).find((a) => a.id === id);
  const canManage = can(org.role, 'accounts.manage');
  return (
    <>
      <PageHeader
        title="Tax rates"
        description="Percentages you apply to invoice and bill lines. Tax on sales posts to a liability; recoverable tax on purchases posts to an asset. This is a calculation aid, not a statutory tax engine: it does not decide which rate applies or prepare returns."
        actions={canManage ? <Button disabled={!accounts.data} onClick={() => { save.reset(); setDraft({ name: '', rate: '', salesAccountId: liability.find((a) => a.subtype === 'TAX_PAYABLE')?.id ?? '', purchaseAccountId: asset.find((a) => a.subtype === 'TAX_RECEIVABLE')?.id ?? '', isActive: true }); }}>New tax rate</Button> : null}
      />
      <Card>
        {rates.data && rates.data.length === 0 ? (
          <EmptyState title="No tax rates yet">Add the rates you charge or pay so invoice and bill lines can use them.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th numeric>Rate</Th><Th>Tax on sales posts to</Th><Th>Tax on purchases posts to</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {(rates.data ?? []).map((t) => (
                <Tr key={t.id}>
                  <Td>{t.name}</Td>
                  <Td numeric className="num">{t.rate}%</Td>
                  <Td className="text-fg-muted">{name(t.salesAccountId) ? `${name(t.salesAccountId)!.code} · ${name(t.salesAccountId)!.name}` : '—'}</Td>
                  <Td className="text-fg-muted">{name(t.purchaseAccountId) ? `${name(t.purchaseAccountId)!.code} · ${name(t.purchaseAccountId)!.name}` : '—'}</Td>
                  <Td>{t.isActive ? <Badge tone="positive">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  <Td className="text-right">{canManage ? <Button size="sm" variant="ghost" onClick={() => { save.reset(); setDraft({ id: t.id, name: t.name, rate: t.rate, salesAccountId: t.salesAccountId ?? '', purchaseAccountId: t.purchaseAccountId ?? '', isActive: t.isActive }); }}>Edit</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={draft?.id ? 'Edit tax rate' : 'New tax rate'}>
        {draft ? (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            {save.error ? <div className="sm:col-span-2"><Alert title="Could not save">{save.error instanceof ApiError ? save.error.message : 'Try again.'}</Alert></div> : null}
            <Field label="Name">{(p) => <Input {...p} required maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
            <Field label="Rate (%)" hint={draft.id ? 'A rate cannot change once created; add a new one instead.' : undefined}>
              {(p) => <Input {...p} required disabled={!!draft.id} inputMode="decimal" value={draft.rate} onChange={(e) => /^\d{0,3}(\.\d{0,6})?$/.test(e.target.value) && setDraft({ ...draft, rate: e.target.value })} />}
            </Field>
            <Field label="Tax on sales posts to">
              {(p) => (
                <Select {...p} value={draft.salesAccountId} onChange={(e) => setDraft({ ...draft, salesAccountId: e.target.value })}>
                  <option value="">Not used on sales</option>
                  {liability.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Tax on purchases posts to">
              {(p) => (
                <Select {...p} value={draft.purchaseAccountId} onChange={(e) => setDraft({ ...draft, purchaseAccountId: e.target.value })}>
                  <option value="">Not used on purchases</option>
                  {asset.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            {draft.id ? <label className="flex items-center gap-2 text-sm text-fg-muted sm:col-span-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label> : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="submit" loading={save.isPending}>Save tax rate</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
