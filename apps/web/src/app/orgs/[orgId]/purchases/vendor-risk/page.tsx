'use client';
import { useQuery } from '@tanstack/react-query';
import { VENDOR_RISK_DECISION_LABEL, VENDOR_RISK_LEVEL_LABEL } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { FactorList } from '@/components/vendor-risk/factor-list';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { LEVEL_TONE, NEED_LABEL, type VendorRiskRow } from '@/lib/vendor-risk';

interface Report {
  asOf: string;
  currency: string;
  totalSpend: string;
  totals: { vendors: number; high: number; medium: number; low: number; needsReview: number; stopped: number };
  vendors: VendorRiskRow[];
}
type Show = 'review' | 'risky' | 'all';

/** Purchases → Vendor risk (AP-024): every active vendor's risk and the reviews waiting. */
export default function VendorRiskPage() {
  const { org, orgId } = useOrg();
  const [show, setShow] = useState<Show>('review');
  const q = useQuery({ queryKey: ['vendor-risk', orgId, 'list'], queryFn: () => api<Report>(`/v1/orgs/${orgId}/purchases/vendor-risk`) });
  if (!org) return null;
  const r = q.data;
  const rows = r ? r.vendors.filter((v) => (show === 'all' ? true : show === 'risky' ? v.level === 'HIGH' || v.level === 'MEDIUM' : !!v.need)) : [];
  return (
    <>
      <PageHeader title="Vendor risk" description="Each active vendor's risk, worked out from what the books hold: bank details changed, unverified or shared with another vendor, tax problems, poor performance, a large share of purchases, onboarding not approved and paying late. A medium or high risk waits for someone to review it." />
      <ErrorAlert title="Could not load vendor risk" error={q.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-4"><p className="text-sm text-fg-muted">Waiting for a review</p><p className={`mt-1 text-2xl font-semibold ${r.totals.needsReview ? 'text-warning' : ''}`}>{r.totals.needsReview}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">High risk</p><p className={`mt-1 text-2xl font-semibold ${r.totals.high ? 'text-negative' : ''}`}>{r.totals.high}</p><p className="text-xs text-fg-muted">{r.totals.medium} medium, {r.totals.low} low</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Active vendors</p><p className="mt-1 text-2xl font-semibold">{r.totals.vendors}</p><p className="text-xs text-fg-muted">{money(r.totalSpend, r.currency)} bought in 12 months</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Decided to stop ordering</p><p className="mt-1 text-2xl font-semibold">{r.totals.stopped}</p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Vendors">
          <CardHeader
            title="Vendor risk register"
            description={`As of ${date(r.asOf)}. Open a vendor to see each factor in full and record a review.`}
            actions={
              <div className="w-56">
                <Select aria-label="Which vendors" value={show} onChange={(e) => setShow(e.target.value as Show)}>
                  <option value="review">Waiting for a review</option>
                  <option value="risky">Medium or high risk</option>
                  <option value="all">All active vendors</option>
                </Select>
              </div>
            }
          />
          {rows.length ? (
            <Table>
              <thead><Tr><Th>Vendor</Th><Th>Risk</Th><Th>What was found</Th><Th>Last review</Th></Tr></thead>
              <tbody>
                {rows.map((v) => (
                  <Tr key={v.id}>
                    <Td className="align-top">
                      <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors/${v.id}`}>{v.name}</Link>
                      <span className="block text-xs text-fg-muted">{v.share ? `${v.share}% of purchases` : 'No purchases in 12 months'}</span>
                    </Td>
                    <Td className="align-top">
                      <Badge tone={LEVEL_TONE[v.level]}>{VENDOR_RISK_LEVEL_LABEL[v.level]}</Badge>
                      {v.need ? <span className="mt-1 block text-xs text-warning">{NEED_LABEL[v.need]}</span> : null}
                    </Td>
                    <Td>{v.factors.length ? <FactorList factors={v.factors} fresh={v.need === 'NEW_RISK' ? v.newFactors : []} detail={false} /> : <span className="text-sm text-fg-muted">Nothing found</span>}</Td>
                    <Td className="align-top text-sm">
                      {v.lastReview ? (
                        <>{VENDOR_RISK_DECISION_LABEL[v.lastReview.decision]}<span className="block text-xs text-fg-muted">{date(v.lastReview.reviewedOn)}{v.lastReview.reviewedBy ? ` by ${v.lastReview.reviewedBy}` : ''}; next by {date(v.lastReview.nextReviewOn)}</span></>
                      ) : <span className="text-fg-muted">Never reviewed</span>}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title={show === 'all' ? 'No active vendors' : show === 'review' ? 'No reviews waiting' : 'No medium or high risks'}>{show === 'all' ? 'Add vendors under Purchases → Vendors.' : 'Choose All active vendors to see every vendor.'}</EmptyState>
          )}
        </Card>
      ) : null}
    </>
  );
}
