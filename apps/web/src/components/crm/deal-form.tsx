'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEAL_STAGE_LABEL, DEAL_STAGE_PROBABILITY, OPEN_DEAL_STAGES } from '@talk2tax/accounting-engine';
import { Button, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import type { Deal, DealDetail, DealStage } from '@/lib/crm';
import { today } from '@/lib/format';
import { useContacts } from '@/lib/org';
import { useOwners } from './lead-dialog';

const plusDays = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Add a deal (with its starting stage), or edit one when `deal` is given. */
export function DealForm({ orgId, currency, deal, meId, contactId, onSaved, onCancel }: { orgId: string; currency: string; deal?: Deal; meId?: string; contactId?: string; onSaved: (d: DealDetail) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const customers = useContacts('customer');
  const owners = useOwners(orgId);
  const [f, setF] = useState({
    name: deal?.name ?? '',
    contactId: deal?.contact?.id ?? contactId ?? '',
    amount: deal?.amount ?? '',
    expectedCloseDate: deal?.expectedCloseDate ?? plusDays(30),
    ownerId: deal ? (deal.owner?.id ?? '') : (meId ?? ''),
    notes: deal?.notes ?? '',
    stage: 'PROSPECTING' as DealStage,
    probability: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const base = { name: f.name, contactId: f.contactId, amount: f.amount.replace(/,/g, ''), expectedCloseDate: f.expectedCloseDate, ownerId: f.ownerId || null, notes: f.notes || null };
      return deal
        ? api<DealDetail>(`/v1/orgs/${orgId}/crm/deals/${deal.id}`, { method: 'PUT', body: base })
        : api<DealDetail>(`/v1/orgs/${orgId}/crm/deals`, { method: 'POST', body: { ...base, stage: f.stage, probability: f.probability ? Number(f.probability) : null } });
    },
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ['crm-deals', orgId] });
      await qc.invalidateQueries({ queryKey: ['crm-deal', orgId, d.id] });
      onSaved(d);
    },
  });
  const closed = deal && (deal.stage === 'WON' || deal.stage === 'LOST');
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Deal name">{(p) => <Input {...p} value={f.name} onChange={set('name')} required placeholder="What is being sold" />}</Field></div>
        <Field label="Customer" hint={customers.data && !customers.data.length ? 'Add a customer first, or convert a lead.' : undefined}>
          {(p) => (
            <Select {...p} value={f.contactId} onChange={set('contactId')} required disabled={!!closed}>
              <option value="" disabled>Choose a customer</option>
              {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={`Amount (${currency})`}>{(p) => <Input {...p} inputMode="decimal" className="num" value={f.amount} onChange={set('amount')} required disabled={!!closed} />}</Field>
        <Field label="Expected to close">{(p) => <Input {...p} type="date" value={f.expectedCloseDate} onChange={set('expectedCloseDate')} required disabled={!!closed} />}</Field>
        <Field label="Owner">{(p) => <Select {...p} value={f.ownerId} onChange={set('ownerId')}><option value="">Nobody yet</option>{owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
        {!deal ? (
          <>
            <Field label="Stage">{(p) => <Select {...p} value={f.stage} onChange={set('stage')}>{OPEN_DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]} ({DEAL_STAGE_PROBABILITY[s]}%)</option>)}</Select>}</Field>
            <Field label="Win probability (%)" hint={`Leave blank for the stage's ${DEAL_STAGE_PROBABILITY[f.stage]}%.`}>{(p) => <Input {...p} inputMode="numeric" className="num" value={f.probability} onChange={set('probability')} />}</Field>
          </>
        ) : null}
      </div>
      <Field label="Notes">{(p) => <Textarea {...p} rows={3} value={f.notes} onChange={set('notes')} />}</Field>
      {closed ? <p className="text-xs text-fg-faint">A closed deal keeps its customer, amount and date. Reopen it to change them.</p> : null}
      <ErrorAlert title="Could not save the deal" error={save.error} />
      <div className="flex justify-end gap-2">
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" loading={save.isPending}>{deal ? 'Save' : 'Add deal'}</Button>
      </div>
    </form>
  );
}
