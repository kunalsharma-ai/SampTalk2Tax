'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Select, Textarea } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { DISPUTE_REASON_LABEL, DISPUTE_REASONS, type DisputeReason, type DisputeSuggestion, type Member } from '@/lib/disputes';

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
export function DisputeForm({ initial, members, today, maxAmount, currency, submitLabel, pending, error, onSubmit, classifyFor }: {
  initial: DisputeFields;
  /** The invoice, to suggest the likely reason as the description is typed (AR-037). */
  classifyFor?: { orgId: string; documentId: string };
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
  const [typed, setTyped] = useState({ description: initial.description.trim(), amount: initial.amount });
  useEffect(() => {
    const t = setTimeout(() => setTyped({ description: f.description.trim(), amount: f.amount }), 400);
    return () => clearTimeout(t);
  }, [f.description, f.amount]);
  const hint = useQuery({
    queryKey: ['dispute-classify', classifyFor?.orgId, classifyFor?.documentId, typed],
    enabled: !!classifyFor && typed.description.length >= 6,
    queryFn: () => api<DisputeSuggestion>(`/v1/orgs/${classifyFor!.orgId}/sales/disputes/classify`, { method: 'POST', body: { documentId: classifyFor!.documentId, description: typed.description, amount: typed.amount && !typed.amount.endsWith('.') ? typed.amount : null } }),
  });
  const s = hint.data && typed.description.length >= 6 ? hint.data : null;
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
      {s && s.reason !== 'OTHER' ? (
        <p role="status" aria-label="Suggestion from the description" className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span>
            Looks like <strong className="text-fg">{s.label}</strong> ({s.confidence.toLowerCase()} confidence){s.because.length ? `: ${s.because.join(', ')}` : ''}.
          </span>
          {s.reason !== f.reason ? <Button type="button" size="sm" variant="secondary" onClick={() => set('reason', s.reason)}>Use {s.label.toLowerCase()}</Button> : null}
        </p>
      ) : null}
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
