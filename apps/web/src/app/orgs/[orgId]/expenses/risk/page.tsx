'use client';
import { useQuery } from '@tanstack/react-query';
import type { ExpenseRiskCode, ExpenseRiskLevel } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Indicator {
  code: ExpenseRiskCode;
  level: ExpenseRiskLevel;
  label: string;
  detail: string;
  lineNos: number[];
  otherClaim: { id: string; number: string; claimantName: string } | null;
}
interface Item {
  claim: { id: string; number: string; title: string; claimantId: string; claimantName: string; status: string; submittedOn: string; currency: string; total: string; receiptCount: number };
  level: ExpenseRiskLevel;
  score: number;
  indicators: Indicator[];
}
interface Person {
  claimantId: string;
  claimantName: string;
  claims: number;
  flagged: number;
  high: number;
  medium: number;
  low: number;
  score: number;
  flaggedTotal: { currency: string; amount: string }[];
  codes: ExpenseRiskCode[];
}
interface Risk {
  asOf: string;
  from: string;
  days: number;
  receiptsFrom: string;
  summary: { claims: number; flagged: number; high: number; medium: number; low: number; people: number };
  items: Item[];
  people: Person[];
}

const TONE: Record<ExpenseRiskLevel, 'negative' | 'warning' | 'neutral'> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };
const LEVEL: Record<ExpenseRiskLevel, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
const STATUS: Record<string, string> = { SUBMITTED: 'Waiting for approval', APPROVED: 'Approved', REIMBURSED: 'Reimbursed' };

/** Unusual expenses and fraud risk indicators (EXP-023, EXP-024). */
export default function ExpenseRiskPage() {
  const { org, orgId } = useOrg();
  const [days, setDays] = useState('90');
  const q = useQuery({ queryKey: ['expense-risk', orgId, days], queryFn: () => api<Risk>(`/v1/orgs/${orgId}/expense-risk?days=${days}`) });
  if (!org) return null;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Unusual expenses"
        description="Expense claims with warning signs, compared across claims and people and with the year before: the same receipt claimed twice, receipts split around a limit, unusually large amounts, lines just under a limit, old or missing receipts, Sundays and round amounts. Nothing here blocks or changes a claim."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Submitted in
              <Select aria-label="Submitted in" className="w-44" value={days} onChange={(e) => setDays(e.target.value)}>
                {[['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 180 days'], ['365', 'Last year']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </label>
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/alerts`}>Alerts</Link>
          </>
        }
      />
      <ErrorAlert title="Could not check expense claims" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Claims with warning signs" value={d.summary.flagged} sub={`Of ${d.summary.claims} submitted since ${date(d.from)}`} />
            <Stat label="High" value={d.summary.high} tone={d.summary.high ? 'negative' : 'positive'} sub="Duplicate receipts, splits around a limit" />
            <Stat label="Medium" value={d.summary.medium} tone={d.summary.medium ? 'warning' : 'positive'} sub="Large, near a limit, old or no receipts" />
            <Stat label="Low" value={d.summary.low} sub="Sundays and round amounts" />
          </div>
          <Card className="mb-4">
            <CardHeader title="People to look at" description="Claimants with flagged claims in the period, by risk score: 3 for each high sign, 2 for each medium and 1 for each low." />
            {!d.people.length ? (
              <EmptyState title="No one stands out">No claim in this period has a warning sign.</EmptyState>
            ) : (
              <Table aria-label="Claimants with warning signs">
                <thead><Tr><Th>Claimant</Th><Th numeric>Claims</Th><Th numeric>Flagged</Th><Th numeric>High</Th><Th numeric>Medium</Th><Th numeric>Low</Th><Th numeric>Score</Th><Th numeric>Flagged total</Th></Tr></thead>
                <tbody>
                  {d.people.map((p) => (
                    <Tr key={p.claimantId}>
                      <Td>{p.claimantName}</Td>
                      <Td numeric>{p.claims}</Td>
                      <Td numeric>{p.flagged}</Td>
                      <Td numeric>{p.high}</Td>
                      <Td numeric>{p.medium}</Td>
                      <Td numeric>{p.low}</Td>
                      <Td numeric><Badge tone={p.high ? 'negative' : p.medium ? 'warning' : 'neutral'}>{p.score}</Badge></Td>
                      <Td numeric>{p.flaggedTotal.map((t) => <div key={t.currency}><Money value={t.amount} currency={t.currency} /></div>)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Claims with warning signs" description="Most serious first, then by score and newest. Draft, rejected and void claims are left out." />
            {!d.items.length ? (
              <EmptyState title="Nothing unusual">No claim submitted in this period has a warning sign.</EmptyState>
            ) : (
              <Table aria-label="Unusual expense claims">
                <thead><Tr><Th>Level</Th><Th>Claim</Th><Th>Claimant</Th><Th>Submitted</Th><Th numeric>Total</Th><Th>Warning signs</Th></Tr></thead>
                <tbody>
                  {d.items.map((i) => (
                    <Tr key={i.claim.id}>
                      <Td><Badge tone={TONE[i.level]}>{LEVEL[i.level]}</Badge></Td>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${i.claim.id}`}>{i.claim.number}</Link><div className="text-xs text-fg-muted">{i.claim.title} · {STATUS[i.claim.status] ?? i.claim.status}</div></Td>
                      <Td>{i.claim.claimantName}</Td>
                      <Td className="whitespace-nowrap">{date(i.claim.submittedOn)}</Td>
                      <Td numeric><Money value={i.claim.total} currency={i.claim.currency} /></Td>
                      <Td>
                        <ul className="space-y-1">
                          {i.indicators.map((x, k) => (
                            <li key={`${x.code}-${k}`}>
                              <Badge tone={TONE[x.level]}>{x.label}</Badge> <span className="text-xs text-fg-muted">{x.detail}</span>
                              {x.otherClaim ? <> <Link className="text-xs text-accent hover:underline" href={`/orgs/${orgId}/expenses/${x.otherClaim.id}`}>Open {x.otherClaim.number}</Link></> : null}
                            </li>
                          ))}
                        </ul>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Checking expense claims…</p> : null}
    </>
  );
}
