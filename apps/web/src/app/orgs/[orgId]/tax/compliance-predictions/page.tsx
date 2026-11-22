'use client';
import { useQuery } from '@tanstack/react-query';
import { DEADLINE_RISK_LABEL, type DeadlinePrediction } from '@talk2tax/tax-engine';
import { Alert, Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Predictions {
  today: string;
  to: string;
  days: number;
  configured: boolean;
  history: number;
  summary: { high: number; medium: number; low: number };
  items: DeadlinePrediction[];
}
const RISK_TONE = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'positive' } as const;
const lead = (n: number) => (n === 0 ? 'on the due date' : n > 0 ? `${n} day${n === 1 ? '' : 's'} early` : `${-n} day${n === -1 ? '' : 's'} late`);

/** Tax → Deadline risk (TAX-047): which upcoming filings and payments are likely to be late, and why. */
export default function CompliancePredictionsPage() {
  const { org, orgId } = useOrg();
  const [days, setDays] = useState('60');
  const q = useQuery({ queryKey: ['compliance-predictions', orgId, days], queryFn: () => api<Predictions>(`/v1/orgs/${orgId}/compliance/predictions?days=${days}`) });
  if (!org) return null;
  const p = q.data;
  return (
    <>
      <PageHeader
        title="Deadline risk"
        description="The filings and payments due soon, each scored for how likely it is to be late: from how early or late the same return was done over the last year, how close the date is, and whether the books are ready (GST accounts that differ from the month's documents, tax mistakes to fix, a pay run not posted). Start with the ones marked likely late."
        actions={<div className="w-40"><Select aria-label="Days ahead" value={days} onChange={(e) => setDays(e.target.value)}>{[30, 60, 90, 120].map((n) => <option key={n} value={n}>Next {n} days</option>)}</Select></div>}
      />
      <ErrorAlert title="Could not work out the deadline risk" error={q.error} />
      {p && !p.configured ? (
        <Alert tone="accent" title="No deadlines to score yet">Set up GST, TDS/TCS or payroll first; the deadlines come from the <Link className="underline" href={`/orgs/${orgId}/tax/compliance`}>compliance calendar</Link>.</Alert>
      ) : null}
      {p && p.configured ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4"><p className="text-sm text-fg-muted">Likely late</p><p className="mt-1 text-2xl font-semibold text-negative">{p.summary.high}</p><p className="text-xs text-fg-muted">Overdue, usually late, or the books are not ready</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">At risk</p><p className="mt-1 text-2xl font-semibold">{p.summary.medium}</p><p className="text-xs text-fg-muted">Late before, close to the date, or a warning</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">On track</p><p className="mt-1 text-2xl font-semibold">{p.summary.low}</p><p className="text-xs text-fg-muted">From {p.history} past deadline{p.history === 1 ? '' : 's'} in the last year</p></Card>
          </div>
          <Card className="mt-6" role="region" aria-label="Deadlines by risk">
            <CardHeader title="Deadlines by risk" description={`Everything open and due by ${date(p.to)}, most at risk first.`} />
            {p.items.length ? (
              <Table aria-label="Deadlines by risk">
                <thead><Tr><Th>Risk</Th><Th>Due</Th><Th>Deadline</Th><Th>Why</Th><Th>Past record</Th></Tr></thead>
                <tbody>
                  {p.items.map((i) => (
                    <Tr key={i.key}>
                      <Td className="align-top whitespace-nowrap"><Badge tone={RISK_TONE[i.risk]}>{DEADLINE_RISK_LABEL[i.risk]}</Badge></Td>
                      <Td className={`align-top ${i.daysLeft < 0 ? 'text-negative' : ''}`}>{date(i.dueDate)}<span className="block text-xs text-fg-muted">{i.daysLeft < 0 ? `${-i.daysLeft} day${i.daysLeft === -1 ? '' : 's'} overdue` : i.daysLeft === 0 ? 'Today' : `In ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`}</span></Td>
                      <Td className="align-top">{i.name}<span className="block text-xs text-fg-muted">{i.periodLabel}</span></Td>
                      <Td className="align-top">
                        <ul className="max-w-md space-y-1 text-sm">
                          {i.signals.map((s) => <li key={s.message} className={s.severity === 'BLOCK' ? 'text-negative' : 'text-warning'}>{s.message}</li>)}
                          {i.reasons.map((r) => <li key={r} className="text-fg-muted">{r}</li>)}
                        </ul>
                      </Td>
                      <Td className="align-top text-sm">
                        {i.history ? (
                          <>Late {i.late} of {i.history}{i.usualLeadDays !== null ? <span className="block text-xs text-fg-muted">Usually {lead(i.usualLeadDays)}</span> : null}{i.predictedDate ? <span className="block text-xs text-fg-muted">Expected {date(i.predictedDate)}</span> : null}</>
                        ) : <span className="text-fg-muted">No record yet</span>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing open">No filings or payments are due in this window.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
