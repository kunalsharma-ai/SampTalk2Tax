'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VENDOR_RISK_DECISION_LABEL, VENDOR_RISK_DECISIONS, VENDOR_RISK_LEVEL_LABEL, type VendorRiskDecision, type VendorRiskLevel } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { LEVEL_TONE, NEED_LABEL, type VendorRiskRow } from '@/lib/vendor-risk';
import { FactorList } from './factor-list';

interface VendorRisk extends VendorRiskRow {
  asOf: string;
  currency: string;
  suggestedNextReviewOn: string;
  reviews: { id: string; level: VendorRiskLevel; factorCodes: string[]; decision: VendorRiskDecision; note: string; reviewedOn: string; nextReviewOn: string; reviewedBy: string | null }[];
}

/** A vendor's risk (AP-024): the factors found, whether a review is waiting, recording one, and past reviews. */
export function VendorRiskCard({ orgId, contactId, canManage }: { orgId: string; contactId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ['vendor-risk', orgId, contactId];
  const q = useQuery({ queryKey: key, queryFn: () => api<VendorRisk>(`/v1/orgs/${orgId}/purchases/vendor-risk/${contactId}`) });
  const d = q.data;
  const [f, setF] = useState({ decision: 'MONITOR' as VendorRiskDecision, note: '', nextReviewOn: '' });
  useEffect(() => {
    if (d) setF((x) => ({ ...x, nextReviewOn: x.nextReviewOn || d.suggestedNextReviewOn }));
  }, [d]);
  const save = useMutation({
    mutationFn: () => api<VendorRisk>(`/v1/orgs/${orgId}/purchases/vendor-risk/${contactId}/reviews`, { method: 'POST', body: f }),
    onSuccess: (x) => {
      qc.setQueryData(key, x);
      void qc.invalidateQueries({ queryKey: ['vendor-risk', orgId, 'list'] });
      setF({ decision: 'MONITOR', note: '', nextReviewOn: x.suggestedNextReviewOn });
    },
  });
  if (q.error) return <div className="mt-6"><Alert title="Could not load the vendor's risk">{q.error.message}</Alert></div>;
  if (!d) return null;
  return (
    <Card className="mt-6" role="region" aria-label="Vendor risk">
      <CardHeader
        title="Vendor risk"
        description="Worked out from this vendor's bank details, tax checks, performance, share of purchases, onboarding and what is owed to them. Review it when it is medium or high."
        actions={<Badge tone={LEVEL_TONE[d.level]}>{d.level === 'NONE' ? 'No risk found' : `${VENDOR_RISK_LEVEL_LABEL[d.level]} risk`}</Badge>}
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <span>Bought in 12 months <span className="num font-medium">{money(d.spend, d.currency)}</span>{d.share ? <span className="text-fg-muted"> ({d.share}% of purchases)</span> : null}</span>
          <span>Owed now <span className="num font-medium">{money(d.owed, d.currency)}</span></span>
          {d.lastReview ? (
            <span>Last review <span className="font-medium">{date(d.lastReview.reviewedOn)}</span>, next by {date(d.lastReview.nextReviewOn)}</span>
          ) : null}
        </div>
        {d.need ? <Alert tone="warning" title={NEED_LABEL[d.need]}>{d.need === 'REVIEW_DUE' ? 'The date set at the last review has come. Look at the factors again and record a review.' : 'Look at each factor below and record what you decided.'}</Alert> : null}
        {d.factors.length ? <FactorList factors={d.factors} fresh={d.need === 'NEW_RISK' ? d.newFactors : []} /> : <p className="text-sm text-positive">Nothing found to worry about.</p>}
        {canManage ? (
          <form aria-label="Record a review" className="flex flex-col gap-3 rounded-md border border-border p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <h3 className="text-sm font-semibold">Record a review</h3>
            {save.error ? <Alert title="Could not record the review">{save.error.message}</Alert> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Decision">{(p) => <Select {...p} value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value as VendorRiskDecision })}>{VENDOR_RISK_DECISIONS.map((x) => <option key={x} value={x}>{VENDOR_RISK_DECISION_LABEL[x]}</option>)}</Select>}</Field>
              <Field label="Review again by" hint="Suggested by the risk: a month for high, three months for medium.">{(p) => <Input {...p} type="date" required value={f.nextReviewOn} onChange={(e) => setF({ ...f, nextReviewOn: e.target.value })} />}</Field>
            </div>
            <Field label="What was looked at and why">{(p) => <Textarea {...p} rows={2} maxLength={1000} required value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
            <div className="flex justify-end"><Button type="submit" loading={save.isPending}>Record review</Button></div>
          </form>
        ) : null}
        {d.reviews.length ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Reviews</h3>
            <Table aria-label="Risk reviews">
              <thead><Tr><Th>Reviewed</Th><Th>Risk then</Th><Th>Decision</Th><Th>Note</Th><Th>Next by</Th><Th>By</Th></Tr></thead>
              <tbody>
                {d.reviews.map((r) => (
                  <Tr key={r.id}>
                    <Td>{date(r.reviewedOn)}</Td>
                    <Td><Badge tone={LEVEL_TONE[r.level]}>{VENDOR_RISK_LEVEL_LABEL[r.level]}</Badge></Td>
                    <Td className="text-sm">{VENDOR_RISK_DECISION_LABEL[r.decision]}</Td>
                    <Td className="text-sm">{r.note}</Td>
                    <Td>{date(r.nextReviewOn)}</Td>
                    <Td className="text-sm">{r.reviewedBy ?? '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
