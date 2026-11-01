'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { checkGstin, checkPan, placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import type { LedgerConfig } from '@/lib/ledgers';
import { useContacts, useGstStates, useOrg, useWithholdingSections } from '@/lib/org';
import { can, type Contact } from '@/lib/types';

export interface ContactDraft {
  id?: string;
  name: string;
  email: string;
  phone: string;
  taxId: string;
  gstin: string;
  stateCode: string;
  pan: string;
  withholdingSectionId: string;
  address: string;
  isCustomer: boolean;
  isVendor: boolean;
  paymentTermsDays: string;
  creditLimit: string;
  isActive: boolean;
}

export function draftFrom(c: Contact | null, l: LedgerConfig): ContactDraft {
  return c
    ? { id: c.id, name: c.name, email: c.email ?? '', phone: c.phone ?? '', taxId: c.taxId ?? '', gstin: c.gstin ?? '', stateCode: c.stateCode ?? '', pan: c.pan ?? '', withholdingSectionId: c.withholdingSectionId ?? '', address: c.address ?? '', isCustomer: c.isCustomer, isVendor: c.isVendor, paymentTermsDays: String(c.paymentTermsDays), creditLimit: c.creditLimit ?? '', isActive: c.isActive }
    : { name: '', email: '', phone: '', taxId: '', gstin: '', stateCode: '', pan: '', withholdingSectionId: '', address: '', isCustomer: l.ledger === 'SALES', isVendor: l.ledger === 'PURCHASES', paymentTermsDays: '30', creditLimit: '', isActive: true };
}

export function ContactDialog({ l, draft, setDraft, onSaved }: { l: LedgerConfig; draft: ContactDraft | null; setDraft: (d: ContactDraft | null) => void; onSaved?: (c: Contact) => void }) {
  const { org, orgId } = useOrg();
  const india = org?.countryCode === 'IN';
  const states = useGstStates();
  const qc = useQueryClient();
  const gstin = draft?.gstin.trim() ? checkGstin(draft.gstin) : null;
  const sections = useWithholdingSections();
  const panFromGstin = gstin?.valid ? gstin.pan! : null;
  const pan = panFromGstin ? null : draft?.pan.trim() ? checkPan(draft.pan) : null;
  const wKind = draft?.isVendor && !draft?.isCustomer ? 'TDS' : draft?.isCustomer && !draft?.isVendor ? 'TCS' : null;
  const wOptions = (sections.data ?? []).filter((x) => (wKind ? x.kind === wKind : true));
  const save = useMutation({
    mutationFn: (d: ContactDraft) => {
      const body = {
        name: d.name,
        email: d.email || null,
        phone: d.phone || null,
        taxId: d.taxId || null,
        ...(india
          ? { gstin: d.gstin.trim() || null, stateCode: d.gstin.trim() ? undefined : d.stateCode || null, pan: d.gstin.trim() ? undefined : d.pan.trim() || null, withholdingSectionId: d.withholdingSectionId || null }
          : {}),
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
          {india ? (
            <>
              <Field label="GSTIN" error={gstin && !gstin.valid ? gstin.issues[0] : undefined} hint={gstin?.valid ? `Registered in ${placeOfSupplyName(gstin.stateCode!)}. Format and check character verified; not looked up on the GST portal.` : 'Leave empty if unregistered.'}>
                {(p) => <Input {...p} className="num uppercase" maxLength={15} value={draft.gstin} onChange={(e) => setDraft({ ...draft, gstin: e.target.value.toUpperCase() })} />}
              </Field>
              <Field label="State" hint={gstin?.valid ? 'Taken from the GSTIN.' : 'The default place of supply for an unregistered contact.'}>
                {(p) => (
                  <Select {...p} disabled={!!gstin?.valid} value={gstin?.valid ? gstin.stateCode : draft.stateCode} onChange={(e) => setDraft({ ...draft, stateCode: e.target.value })}>
                    <option value="">Not set</option>
                    {(states.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.code === '96' ? '96 · Outside India' : `${s.code} · ${s.name}`}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="PAN" error={pan && !pan.valid ? pan.issues[0] : undefined} hint={panFromGstin ? `${panFromGstin}, from the GSTIN.` : pan?.valid ? `${pan.holderType}. Decides TDS and TCS rates; not looked up on the income-tax portal.` : 'Without a PAN, TDS and TCS use the higher no-PAN rate.'}>
                {(p) => <Input {...p} className="num uppercase" maxLength={10} disabled={!!panFromGstin} value={panFromGstin ?? draft.pan} onChange={(e) => setDraft({ ...draft, pan: e.target.value.toUpperCase() })} />}
              </Field>
              {wOptions.length ? (
                <Field label={wKind === 'TCS' ? 'Default TCS section' : wKind === 'TDS' ? 'Default TDS section' : 'Default TDS/TCS section'} hint="Pre-selected on new bills or invoices.">
                  {(p) => (
                    <Select {...p} value={draft.withholdingSectionId} onChange={(e) => setDraft({ ...draft, withholdingSectionId: e.target.value })}>
                      <option value="">None</option>
                      {wOptions.map((x) => <option key={x.id} value={x.id}>{x.kind} {x.code} · {x.name}</option>)}
                    </Select>
                  )}
                </Field>
              ) : null}
            </>
          ) : null}
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
            <Button type="submit" loading={save.isPending} disabled={(!draft.isCustomer && !draft.isVendor) || (!!gstin && !gstin.valid) || (!!pan && !pan.valid)}>Save {l.contact.toLowerCase()}</Button>
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
                    {x.gstin ? <p className="num text-xs text-fg-muted">GSTIN {x.gstin}</p> : x.pan ? <p className="num text-xs text-fg-muted">PAN {x.pan}</p> : null}
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
