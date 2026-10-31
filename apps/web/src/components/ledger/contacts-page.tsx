'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import type { LedgerConfig } from '@/lib/ledgers';
import { useContacts, useOrg } from '@/lib/org';
import { can, type Contact } from '@/lib/types';

export interface ContactDraft {
  id?: string;
  name: string;
  email: string;
  phone: string;
  taxId: string;
  address: string;
  isCustomer: boolean;
  isVendor: boolean;
  paymentTermsDays: string;
  creditLimit: string;
  isActive: boolean;
}

export function draftFrom(c: Contact | null, l: LedgerConfig): ContactDraft {
  return c
    ? { id: c.id, name: c.name, email: c.email ?? '', phone: c.phone ?? '', taxId: c.taxId ?? '', address: c.address ?? '', isCustomer: c.isCustomer, isVendor: c.isVendor, paymentTermsDays: String(c.paymentTermsDays), creditLimit: c.creditLimit ?? '', isActive: c.isActive }
    : { name: '', email: '', phone: '', taxId: '', address: '', isCustomer: l.ledger === 'SALES', isVendor: l.ledger === 'PURCHASES', paymentTermsDays: '30', creditLimit: '', isActive: true };
}

export function ContactDialog({ l, draft, setDraft, onSaved }: { l: LedgerConfig; draft: ContactDraft | null; setDraft: (d: ContactDraft | null) => void; onSaved?: (c: Contact) => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (d: ContactDraft) => {
      const body = {
        name: d.name,
        email: d.email || null,
        phone: d.phone || null,
        taxId: d.taxId || null,
        address: d.address || null,
        isCustomer: d.isCustomer,
        isVendor: d.isVendor,
        paymentTermsDays: Number(d.paymentTermsDays || '0'),
        creditLimit: d.creditLimit || null,
      };
      return d.id
        ? api<Contact>(`/v1/orgs/${orgId}/contacts/${d.id}`, { method: 'PATCH', body: { ...body, isActive: d.isActive } })
        : api<Contact>(`/v1/orgs/${orgId}/contacts`, { method: 'POST', body });
    },
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ['contacts', orgId] });
      await qc.invalidateQueries({ queryKey: ['contact', orgId] });
      setDraft(null);
      onSaved?.(c);
    },
  });
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={draft?.id ? `Edit ${draft.name}` : `New ${l.contact.toLowerCase()}`}>
      {draft ? (
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
          {save.error ? <div className="sm:col-span-2"><Alert title="Could not save">{save.error instanceof ApiError ? [save.error.message, ...save.error.issues].join(' · ') : 'Try again.'}</Alert></div> : null}
          <div className="sm:col-span-2">
            <Field label="Name">{(p) => <Input {...p} required maxLength={200} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
          </div>
          <Field label="Email">{(p) => <Input {...p} type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />}</Field>
          <Field label="Phone">{(p) => <Input {...p} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />}</Field>
          <Field label="Tax ID" hint="Stored as entered. Not validated against any tax authority.">{(p) => <Input {...p} value={draft.taxId} onChange={(e) => setDraft({ ...draft, taxId: e.target.value })} />}</Field>
          <Field label="Payment terms (days)">{(p) => <Input {...p} inputMode="numeric" value={draft.paymentTermsDays} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setDraft({ ...draft, paymentTermsDays: e.target.value })} />}</Field>
          {draft.isCustomer ? (
            <Field label="Credit limit" hint="Leave empty for no limit. Posting an invoice above it needs an explicit override.">
              {(p) => <Input {...p} inputMode="decimal" value={draft.creditLimit} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setDraft({ ...draft, creditLimit: e.target.value })} />}
            </Field>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Address">{(p) => <Input {...p} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />}</Field>
          </div>
          <fieldset className="flex flex-wrap gap-4 text-sm text-fg-muted sm:col-span-2">
            <legend className="sr-only">Roles</legend>
            <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={draft.isCustomer} onChange={(e) => setDraft({ ...draft, isCustomer: e.target.checked })} /> Customer</label>
            <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={draft.isVendor} onChange={(e) => setDraft({ ...draft, isVendor: e.target.checked })} /> Vendor</label>
            {draft.id ? <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label> : null}
          </fieldset>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button type="submit" loading={save.isPending} disabled={!draft.isCustomer && !draft.isVendor}>Save {l.contact.toLowerCase()}</Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

export function ContactsPage({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const contacts = useContacts(l.contactRole, showInactive);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  if (!org) return null;
  const c = org.functionalCurrency;
  const rows = (contacts.data ?? []).filter((x) => !search || x.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHeader
        title={l.contacts}
        description={`Balances come from posted ${l.charge.plural.toLowerCase()}, ${l.credit.plural.toLowerCase()} and ${l.payment.plural.toLowerCase()}.`}
        actions={
          <>
            <label className="sr-only" htmlFor="contact-search">Search</label>
            <Input id="contact-search" className="w-48" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-[var(--t2t-accent)]" /> Show inactive
            </label>
            {can(org.role, 'contacts.manage') ? <Button onClick={() => setDraft(draftFrom(null, l))}>New {l.contact.toLowerCase()}</Button> : null}
          </>
        }
      />
      {contacts.error ? <Alert title={`Could not load ${l.contacts.toLowerCase()}`}>{(contacts.error as Error).message}</Alert> : null}
      <Card>
        {contacts.data && rows.length === 0 ? (
          <EmptyState title={`No ${l.contacts.toLowerCase()} yet`}>Add one to start issuing {l.charge.plural.toLowerCase()}.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th numeric>Terms</Th>
                <Th numeric>Overdue</Th>
                <Th numeric>Balance</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <Tr key={x.id}>
                  <Td>
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.contactsPath}/${x.id}`}>{x.name}</Link>
                    {!x.isActive ? <Badge className="ml-2">Inactive</Badge> : null}
                    {x.isCustomer && x.isVendor ? <Badge className="ml-2" tone="violet">Customer and vendor</Badge> : null}
                  </Td>
                  <Td className="text-fg-muted">{x.email}</Td>
                  <Td numeric className="text-fg-muted">{x.paymentTermsDays} days</Td>
                  <Td numeric>{x[l.balanceKey].overdue !== '0.00' ? <Money className="text-warning" value={x[l.balanceKey].overdue} currency={c} /> : <span className="text-fg-faint">—</span>}</Td>
                  <Td numeric><Money value={x[l.balanceKey].balance} currency={c} signed /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <ContactDialog l={l} draft={draft} setDraft={setDraft} />
    </>
  );
}
