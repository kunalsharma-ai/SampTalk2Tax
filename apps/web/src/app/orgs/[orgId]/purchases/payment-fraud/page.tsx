'use client';
import { useQuery } from '@tanstack/react-query';
import { FRAUD_LEVEL_LABEL, FRAUD_LEVELS, type FraudLevel } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface FlaggedPayment {
  key: string;
  source: 'BATCH' | 'PAYMENT';
  ref: { id: string; label: string; status?: string };
  contactId: string;
  vendor: string;
  date: string;
  amount: string;
  currency: string;
  level: FraudLevel;
  indicators: { code: string; level: FraudLevel; detail: string }[];
}
interface FraudReport {
  asOf: string;
  windowDays: number;
  summary: { checked: number; flagged: number; high: number; medium: number; low: number; inBatches: number };
  payments: FlaggedPayment[];
}

const TONE: Record<FraudLevel, 'negative' | 'warning' | 'neutral'> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };

/** Payment fraud indicators (AP-028): warning signs on vendor payments, before and after they are made. */
export default function PaymentFraudPage() {
  const { orgId } = useOrg();
  const [level, setLevel] = useState<FraudLevel | 'ALL'>('ALL');
  const q = useQuery({ queryKey: ['payment-fraud', orgId], queryFn: () => api<FraudReport>(`/v1/orgs/${orgId}/payment-fraud`) });
  const d = q.data;
  const rows = d ? (level === 'ALL' ? d.payments : d.payments.filter((p) => p.level === level)) : [];
  return (
    <>
      <PageHeader title="Payment fraud checks" description="Warning signs on vendor payments waiting in payment batches and recorded in the last 90 days: bank accounts shared with employees or other vendors, bank details changed just before paying, duplicate payments, new vendors and more. Nothing here changes the books." />
      <ErrorAlert title="Could not load payment fraud checks" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Payments checked" value={d.summary.checked} sub={`${d.summary.flagged} with warning signs`} />
            <Stat label="High" value={d.summary.high} tone={d.summary.high ? 'negative' : 'positive'} sub="Check before paying" />
            <Stat label="Medium" value={d.summary.medium} tone={d.summary.medium ? 'warning' : 'positive'} />
            <Stat label="In open batches" value={d.summary.inBatches} tone={d.summary.inBatches ? 'warning' : 'positive'} sub="Not paid yet: stop them in time" />
          </div>
          <Card>
            <CardHeader
              title="Payments with warning signs"
              description="Most serious first; payments still waiting in a batch come before those already made."
              actions={
                <Select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as FraudLevel | 'ALL')} className="w-40">
                  <option value="ALL">All levels</option>
                  {FRAUD_LEVELS.map((l) => <option key={l} value={l}>{FRAUD_LEVEL_LABEL[l]}</option>)}
                </Select>
              }
            />
            {!rows.length ? (
              <EmptyState title="No warning signs">{d.summary.checked ? 'None of the payments checked shows a warning sign.' : 'No vendor payments in open batches or in the last 90 days.'}</EmptyState>
            ) : (
              <Table aria-label="Payments with warning signs">
                <thead><Tr><Th>Level</Th><Th>Payment</Th><Th>Vendor</Th><Th>Date</Th><Th numeric>Amount</Th><Th>Warning signs</Th></Tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <Tr key={p.key}>
                      <Td><Badge tone={TONE[p.level]}>{FRAUD_LEVEL_LABEL[p.level]}</Badge></Td>
                      <Td>
                        <Link className="text-accent hover:underline" href={p.source === 'BATCH' ? `/orgs/${orgId}/purchases/payment-batches/${p.ref.id}` : `/orgs/${orgId}/purchases/payments/${p.ref.id}`}>{p.ref.label}</Link>
                        <div className="text-xs text-fg-muted">{p.source === 'BATCH' ? `Waiting in a batch (${p.ref.status === 'APPROVED' ? 'approved' : 'draft'})` : 'Paid'}</div>
                      </Td>
                      <Td><Link className="hover:underline" href={`/orgs/${orgId}/purchases/vendors/${p.contactId}`}>{p.vendor}</Link></Td>
                      <Td className="whitespace-nowrap">{date(p.date)}</Td>
                      <Td numeric><Money value={p.amount} currency={p.currency} /></Td>
                      <Td>
                        <ul className="space-y-1 text-xs">
                          {p.indicators.map((i) => <li key={i.code}><Badge tone={TONE[i.level]}>{FRAUD_LEVEL_LABEL[i.level]}</Badge> {i.detail}</li>)}
                        </ul>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
