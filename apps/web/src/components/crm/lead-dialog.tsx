'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEAD_SOURCE_LABEL, LEAD_SOURCES } from '@talk2tax/accounting-engine';
import { Button, Dialog, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import type { Lead, LeadDetail, LeadSource, Owner } from '@/lib/crm';

type Draft = { name: string; company: string; email: string; phone: string; source: LeadSource; ownerId: string; estimatedValue: string; notes: string };
const empty = (ownerId: string): Draft => ({ name: '', company: '', email: '', phone: '', source: 'WEBSITE', ownerId, estimatedValue: '', notes: '' });
const fromLead = (l: Lead): Draft => ({ name: l.name, company: l.company ?? '', email: l.email ?? '', phone: l.phone ?? '', source: l.source, ownerId: l.owner?.id ?? '', estimatedValue: l.estimatedValue ?? '', notes: l.notes ?? '' });

export function useOwners(orgId: string) {
  return useQuery({ queryKey: ['crm-owners', orgId], queryFn: () => api<Owner[]>(`/v1/orgs/${orgId}/crm/owners`) });
}

/** Add a lead, or edit one (when `lead` is given). */
export function LeadDialog({ orgId, open, onOpenChange, lead, meId, currency }: { orgId: string; open: boolean; onOpenChange: (o: boolean) => void; lead?: Lead; meId?: string; currency: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const owners = useOwners(orgId);
  const [f, setF] = useState<Draft>(() => (lead ? fromLead(lead) : empty(meId ?? '')));
  useEffect(() => {
    if (open) setF(lead ? fromLead(lead) : empty(meId ?? ''));
  }, [open, lead, meId]);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, company: f.company || null, email: f.email || null, phone: f.phone || null, ownerId: f.ownerId || null, estimatedValue: f.estimatedValue.replace(/,/g, '') || null, notes: f.notes || null };
      return lead ? api<LeadDetail>(`/v1/orgs/${orgId}/crm/leads/${lead.id}`, { method: 'PUT', body }) : api<LeadDetail>(`/v1/orgs/${orgId}/crm/leads`, { method: 'POST', body });
    },
    onSuccess: async (l) => {
      await qc.invalidateQueries({ queryKey: ['crm-leads', orgId] });
      await qc.invalidateQueries({ queryKey: ['crm-lead', orgId, l.id] });
      onOpenChange(false);
      if (!lead) router.push(`/orgs/${orgId}/sales/leads/${l.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={lead ? `Edit ${lead.reference}` : 'Add a lead'} description="Someone who might buy. Qualify the lead, then convert it into a customer and a deal.">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">{(p) => <Input {...p} value={f.name} onChange={set('name')} required placeholder="Person you speak to" />}</Field>
          <Field label="Company">{(p) => <Input {...p} value={f.company} onChange={set('company')} placeholder="Becomes the customer's name" />}</Field>
          <Field label="Email">{(p) => <Input {...p} type="email" value={f.email} onChange={set('email')} />}</Field>
          <Field label="Phone">{(p) => <Input {...p} value={f.phone} onChange={set('phone')} />}</Field>
          <Field label="Source">{(p) => <Select {...p} value={f.source} onChange={set('source')}>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{LEAD_SOURCE_LABEL[s]}</option>)}</Select>}</Field>
          <Field label="Owner">{(p) => <Select {...p} value={f.ownerId} onChange={set('ownerId')}><option value="">Nobody yet</option>{owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
          <Field label={`Estimated value (${currency})`} hint="Optional: a first guess.">{(p) => <Input {...p} inputMode="decimal" className="num" value={f.estimatedValue} onChange={set('estimatedValue')} />}</Field>
        </div>
        <Field label="Notes">{(p) => <Textarea {...p} rows={3} value={f.notes} onChange={set('notes')} />}</Field>
        <ErrorAlert title="Could not save the lead" error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{lead ? 'Save' : 'Add lead'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
