'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Textarea } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { SEVERITY_LABEL, SEVERITY_TONE, type BillCheck } from '@/lib/bill-checks';
import { dateTime } from '@/lib/format';

/** Unusual bill checks (AP-031) on a bill's page: the findings and their review. */
export function BillChecksCard({ orgId, documentId, canManage }: { orgId: string; documentId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ['bill-checks', orgId, documentId];
  const q = useQuery({ queryKey: key, queryFn: () => api<BillCheck>(`/v1/orgs/${orgId}/purchases/bill-checks/${documentId}`) });
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const review = useMutation({
    mutationFn: () => api<BillCheck>(`/v1/orgs/${orgId}/purchases/bill-checks/${documentId}/review`, { method: 'POST', body: { note } }),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      void qc.invalidateQueries({ queryKey: ['bill-checks', orgId] });
      setOpen(false);
      setNote('');
    },
  });
  const r = q.data;
  if (!r) return <ErrorAlert title="Could not check the bill" error={q.error as Error | null} />;
  const reviewed = r.review?.current;
  return (
    <section aria-label="Unusual bill checks">
      <Card className="mb-6">
        <CardHeader
          title="Unusual bill checks"
          description={r.findings.length ? `Compared with ${r.vendor}'s earlier bills and bank details.` : `Nothing unusual against ${r.vendor}'s earlier bills and bank details.`}
          actions={r.findings.length ? (reviewed ? <Badge tone="positive">Reviewed</Badge> : canManage && !open ? <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Mark reviewed…</Button> : <Badge tone="warning">Not reviewed</Badge>) : null}
        />
        {r.findings.length ? (
          <ul className="divide-y divide-line">
            {r.findings.map((f) => (
              <li key={f.code + f.detail} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
                <Badge tone={SEVERITY_TONE[f.severity]} className="mt-0.5 whitespace-nowrap">{SEVERITY_LABEL[f.severity]}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{f.label}</p>
                  <p className="text-fg-muted">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {r.review ? (
          <p className="border-t border-line px-5 py-3 text-sm text-fg-muted" role="note" aria-label="Last review">
            {r.review.current ? 'Reviewed' : 'Reviewed earlier, before the findings changed,'} by {r.review.by ?? 'someone'} on {dateTime(r.review.at)}: “{r.review.note}”
          </p>
        ) : null}
        {open ? (
          <form className="space-y-3 border-t border-line p-5" onSubmit={(e) => { e.preventDefault(); review.mutate(); }}>
            <Field label="Why the bill is fine" hint="For example: called the vendor on the number in the contract. Kept with the bill and in the audit trail.">
              {(p) => <Textarea {...p} rows={2} required minLength={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <ErrorAlert title="Could not save the review" error={review.error as Error | null} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={review.isPending}>Save review</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        ) : null}
      </Card>
    </section>
  );
}
