'use client';
import { useQuery } from '@tanstack/react-query';
import { BEHAVIOUR_SIGNAL_LABEL, BEHAVIOUR_SIGNALS, type BehaviourProfile, type BehaviourSignalCode, type BehaviourTone } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Row {
  contactId: string;
  name: string;
  profile: BehaviourProfile;
  profileLabel: string;
  paying: { paidInvoices: number; daysLate: number | null; daysLateRecent: number | null; daysLatePrior: number | null; trend: 'FASTER' | 'STEADY' | 'SLOWER' | null; spread: number | null; partialShare: number | null; payDay: number | null };
  buying: { last12: { invoices: number; amount: string }; prior12: { invoices: number; amount: string }; change: number | null; trend: string | null; lastInvoiceOn: string | null; daysSinceLast: number | null };
  signals: { code: BehaviourSignalCode; tone: BehaviourTone; label: string; detail: string }[];
}
interface Behaviour {
  asOf: string;
  currency: string;
  summary: { customers: number; profiles: Record<BehaviourProfile, number>; signals: Record<BehaviourSignalCode, number> };
  customers: Row[];
}

const PROFILE_TONE: Record<BehaviourProfile, 'positive' | 'warning' | 'negative' | 'neutral' | 'accent'> = { PROMPT: 'positive', SLOW: 'warning', ERRATIC: 'negative', NEW: 'accent', LITTLE_HISTORY: 'neutral' };
const SIGNAL_TONE: Record<BehaviourTone, 'negative' | 'warning' | 'positive' | 'neutral'> = { RISK: 'negative', WATCH: 'warning', GOOD: 'positive', INFO: 'neutral' };
const TREND: Record<string, string> = { FASTER: 'paying faster', STEADY: 'steady', SLOWER: 'paying slower' };
const BUYING: Record<string, string> = { GROWING: 'Growing', STEADY: 'Steady', SHRINKING: 'Shrinking', LAPSED: 'Stopped', NEW: 'New' };

/** Customer financial behaviour analysis (AR-038): how each customer pays and buys, and what is changing. */
export default function CustomerBehaviourPage() {
  const { org, orgId } = useOrg();
  const [signal, setSignal] = useState<BehaviourSignalCode | ''>('');
  const q = useQuery({ queryKey: ['customer-behaviour', orgId], queryFn: () => api<Behaviour>(`/v1/orgs/${orgId}/customer-behaviour`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  const rows = d ? d.customers.filter((x) => !signal || x.signals.some((s) => s.code === signal)) : [];
  return (
    <>
      <PageHeader
        title="Customer behaviour"
        description="How each customer invoiced in the last two years pays and buys, and what is changing: paying slower or faster, buying less or more, stopping, paying in parts, and the day of the month they usually pay. Nothing here changes the books."
        actions={
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            Signal
            <Select aria-label="Signal" className="w-48" value={signal} onChange={(e) => setSignal(e.target.value as BehaviourSignalCode | '')}>
              <option value="">All customers</option>
              {BEHAVIOUR_SIGNALS.map((g) => <option key={g} value={g}>{BEHAVIOUR_SIGNAL_LABEL[g]}{d ? ` (${d.summary.signals[g]})` : ''}</option>)}
            </Select>
          </label>
        }
      />
      <ErrorAlert title="Could not load customer behaviour" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Customers analysed" value={d.summary.customers} sub="Invoiced in the last two years" />
            <Stat label="Paying slower" value={d.summary.signals.PAYING_SLOWER} tone={d.summary.signals.PAYING_SLOWER ? 'negative' : 'positive'} sub="Than six months before" />
            <Stat label="Stopped buying" value={d.summary.signals.LAPSED} tone={d.summary.signals.LAPSED ? 'negative' : 'positive'} sub={`Buying less: ${d.summary.signals.BUYING_LESS}`} />
            <Stat label="Pay on time" value={d.summary.profiles.PROMPT} tone="positive" sub={`Unpredictable: ${d.summary.profiles.ERRATIC}`} />
          </div>
          <Card>
            <CardHeader title="How customers pay and buy" description="Customers with a warning come first. Days late are weighted by invoice amount, over invoices paid in the last 12 months." />
            {!rows.length ? (
              <EmptyState title="No customers here">{signal ? 'No customer has this signal.' : 'No customer has been invoiced in the last two years.'}</EmptyState>
            ) : (
              <Table aria-label="Customer behaviour">
                <thead><Tr><Th>Customer</Th><Th>Profile</Th><Th>Paying</Th><Th>Buying, last 12 months</Th><Th>Signals</Th></Tr></thead>
                <tbody>
                  {rows.map((x) => (
                    <Tr key={x.contactId}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${x.contactId}`}>{x.name}</Link></Td>
                      <Td><Badge tone={PROFILE_TONE[x.profile]} className="whitespace-nowrap">{x.profileLabel}</Badge></Td>
                      <Td>
                        {x.paying.daysLate != null ? <>{x.paying.daysLate} days late on average</> : <span className="text-fg-muted">Nothing paid in 12 months</span>}
                        <div className="text-xs text-fg-muted">
                          {x.paying.paidInvoices} paid{x.paying.trend ? ` · ${TREND[x.paying.trend]}` : ''}{x.paying.spread != null ? ` · varies by ${x.paying.spread} days` : ''}{x.paying.partialShare ? ` · ${x.paying.partialShare}% in parts` : ''}
                        </div>
                      </Td>
                      <Td>
                        <Money value={x.buying.last12.amount} currency={c} />
                        <div className="text-xs text-fg-muted">
                          {x.buying.last12.invoices} invoices{x.buying.change != null ? ` · ${x.buying.change > 0 ? '+' : ''}${x.buying.change}% on the year before` : ''}{x.buying.trend ? ` · ${BUYING[x.buying.trend]}` : ''}
                          {x.buying.lastInvoiceOn ? <> · last {date(x.buying.lastInvoiceOn)}</> : null}
                        </div>
                      </Td>
                      <Td>
                        {x.signals.length ? (
                          <ul className="space-y-1">
                            {x.signals.map((s) => <li key={s.code}><Badge tone={SIGNAL_TONE[s.tone]}>{s.label}</Badge> <span className="text-xs text-fg-muted">{s.detail}</span></li>)}
                          </ul>
                        ) : <span className="text-fg-muted">None</span>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Working out customer behaviour…</p> : null}
    </>
  );
}
