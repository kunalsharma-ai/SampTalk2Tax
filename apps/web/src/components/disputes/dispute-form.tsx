'use client';
import { Button, Input, Select, Textarea } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DISPUTE_REASON_LABEL, DISPUTE_REASONS, type DisputeReason, type Member } from '@/lib/disputes';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';
const AMOUNT = /^\d{0,18}(\.\d{0,6})?$/;

export interface DisputeFields {
  amount: string;
  reason: DisputeReason;
  description: string;
  ownerId: string;
  targetDate: string;
}

/** The fields of a dispute, for raising one or changing it. */
export function DisputeForm({ initial, members, today, maxAmount, currency, submitLabel, pending, error, onSubmit }: {
  initial: DisputeFields;
  members: Member[];
  today: string;
  maxAmount: string;
  currency: string;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (f: DisputeFields) => void;
}) {
  const [f, setF] = useState(initial);
  const set = <K extends keyof DisputeFields>(k: K, v: DisputeFields[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}>
      <label className={label}>
        Reason
        <Select value={f.reason} onChange={(e) => set('reason', e.target.value as DisputeReason)}>
          {DISPUTE_REASONS.map((r) => <option key={r} value={r}>{DISPUTE_REASON_LABEL[r]}</option>)}
        </Select>
      </label>
      <label className={label}>
        What the customer disputes
        <Textarea rows={3} maxLength={1000} value={f.description} placeholder="e.g. Billed at 1,000 a unit; the order says 750" onChange={(e) => set('description', e.target.value)} />
      </label>
      <label className={label}>
        Amount in dispute ({currency}, up to {maxAmount})
        <Input inputMode="decimal" className="num" placeholder={maxAmount} value={f.amount} onChange={(e) => AMOUNT.test(e.target.value) && set('amount', e.target.value)} />
        <span className="normal-case tracking-normal text-fg-muted">Leave empty for all that is still due.</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Owner
          <Select value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
            <option value="">No one yet</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </label>
        <label className={label}>
          Settle by
          <Input type="date" min={today} value={f.targetDate} onChange={(e) => set('targetDate', e.target.value)} />
        </label>
      </div>
      <ErrorAlert title="The dispute was not saved" error={error} />
      <div className="flex justify-end">
        <Button type="submit" loading={pending} disabled={!f.description.trim()}>{submitLabel}</Button>
      </div>
    </form>
  );
}

export const toBody = (f: DisputeFields) => ({ amount: f.amount || null, reason: f.reason, description: f.description, ownerId: f.ownerId || null, targetDate: f.targetDate || null });
