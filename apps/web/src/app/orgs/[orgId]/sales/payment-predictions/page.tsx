'use client';
import { useQuery } from '@tanstack/react-query';
import { addDays, PREDICTION_BAND_LABEL, PREDICTION_BANDS, PREDICTION_CONFIDENCE_LABEL, type PredictionBand, type PredictionConfidence } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Prediction {
  invoiceId: string;
  contactId: string;
  number: string;
  customer: string;
  issueDate: string;
  dueDate: string;
  outstanding: string;
  expectedDaysLate: number;
  predictedPayDate: string;
  lateChance: number;
  band: PredictionBand;
  confidence: PredictionConfidence;
  basedOn: number;
  daysPastDue: number;
  reasons: string[];
}
interface Predictions {
  asOf: string;
  currency: string;
  summary: { invoices: number; outstanding: string; byBand: Record<PredictionBand, { invoices: number; outstanding: string }>; expectedIn30Days: string; atRisk: string; unscored: number; paidHistory: number };
  accuracy: { tested: number; meanErrorDays: number | null; withinWeekShare: number | null; rightBandShare: number | null };
  invoices: Prediction[];
}

const TONE: Record<PredictionBand, 'positive' | 'warning' | 'negative'> = { ON_TIME: 'positive', LATE: 'warning', VERY_LATE: 'negative' };
const share = (x: number | null) => (x == null ? 'Not yet' : `${Math.round(x * 100)}%`);
const days = (n: number) => (n === 0 ? 'On the due date' : `${n} ${n === 1 ? 'day' : 'days'} after the due date`);

/** Predictive payment-delay scoring (AR-033): when each open invoice is likely to be paid, and why. */
export default function PaymentPredictionsPage() {
  const { org, orgId } = useOrg();
  const [band, setBand] = useState<PredictionBand | 'ALL'>('ALL');
  const q = useQuery({ queryKey: ['payment-predictions', orgId], queryFn: () => api<Predictions>(`/v1/orgs/${orgId}/payment-predictions`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  const rows = d ? (band === 'ALL' ? d.invoices : d.invoices.filter((i) => i.band === band)) : [];
  return (
    <>
      <PageHeader title="Payment predictions" description="When each open invoice is likely to be paid, the chance it is paid late and why, worked out from how each customer has paid before. Nothing here changes the books." />
      <ErrorAlert title="Could not load payment predictions" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Open invoices" value={<Money value={d.summary.outstanding} currency={c} />} sub={`${d.summary.invoices} scored${d.summary.unscored ? `, ${d.summary.unscored} not scored` : ''}`} />
            <Stat label="Expected in the next 30 days" value={<Money value={d.summary.expectedIn30Days} currency={c} />} tone="positive" sub={`By ${date(addDays(d.asOf, 30))}`} />
            <Stat label="Likely to be late" value={<Money value={d.summary.atRisk} currency={c} />} tone="warning" sub="Each invoice weighted by its chance of being late" />
            <Stat label="Very late (over 30 days)" value={<Money value={d.summary.byBand.VERY_LATE.outstanding} currency={c} />} tone="negative" sub={`${d.summary.byBand.VERY_LATE.invoices} ${d.summary.byBand.VERY_LATE.invoices === 1 ? 'invoice' : 'invoices'}`} />
          </div>
          <Card className="mb-4">
            <CardHeader
              title="Predicted payment of open invoices"
              description="Riskiest first. Up to five days after the due date counts as on time."
              actions={
                <Select aria-label="Show" value={band} onChange={(e) => setBand(e.target.value as PredictionBand | 'ALL')} className="w-44">
                  <option value="ALL">All bands</option>
                  {PREDICTION_BANDS.map((b) => <option key={b} value={b}>{PREDICTION_BAND_LABEL[b]} ({d.summary.byBand[b].invoices})</option>)}
                </Select>
              }
            />
            {!d.summary.paidHistory ? (
              <EmptyState title="No payment history yet">Predictions start once a customer has paid an invoice in full: receipts and credits applied to invoices are what the predictions learn from.</EmptyState>
            ) : !rows.length ? (
              <EmptyState title="Nothing to predict">No open invoices{band === 'ALL' ? '' : ` predicted ${PREDICTION_BAND_LABEL[band].toLowerCase()}`}.</EmptyState>
            ) : (
              <Table aria-label="Predicted payments">
                <thead><Tr><Th>Invoice</Th><Th>Customer</Th><Th>Due</Th><Th numeric>Outstanding</Th><Th>Likely paid</Th><Th numeric>Chance late</Th><Th>Why</Th></Tr></thead>
                <tbody>
                  {rows.map((i) => (
                    <Tr key={i.invoiceId}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${i.invoiceId}`}>{i.number}</Link></Td>
                      <Td><Link className="hover:underline" href={`/orgs/${orgId}/sales/customers/${i.contactId}`}>{i.customer}</Link></Td>
                      <Td className="whitespace-nowrap">{date(i.dueDate)}{i.daysPastDue ? <div className="text-xs text-danger">{i.daysPastDue} days past due</div> : null}</Td>
                      <Td numeric><Money value={i.outstanding} currency={c} /></Td>
                      <Td className="whitespace-nowrap">{date(i.predictedPayDate)}<div className="text-xs text-fg-muted">{days(i.expectedDaysLate)}</div></Td>
                      <Td numeric><Badge tone={TONE[i.band]}>{PREDICTION_BAND_LABEL[i.band]} · {i.lateChance}%</Badge><div className="text-xs text-fg-muted">Confidence: {PREDICTION_CONFIDENCE_LABEL[i.confidence].toLowerCase()}</div></Td>
                      <Td><ul className="list-disc pl-4 text-xs">{i.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="How accurate predictions have been" description="Each invoice paid in the last year, predicted from only what was known on the day it was issued, then compared with when it was actually paid." />
            {d.accuracy.tested ? (
              <div className="grid gap-4 p-4 sm:grid-cols-4">
                <Stat label="Invoices checked" value={d.accuracy.tested} />
                <Stat label="Average miss" value={`${d.accuracy.meanErrorDays} days`} />
                <Stat label="Within a week" value={share(d.accuracy.withinWeekShare)} tone="positive" />
                <Stat label="Right band" value={share(d.accuracy.rightBandShare)} tone="accent" sub="On time, late or very late" />
              </div>
            ) : (
              <EmptyState title="Not enough history to check">Accuracy shows once invoices have been paid after earlier ones were.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

