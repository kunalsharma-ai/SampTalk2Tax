'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

type PeriodState = 'NEXT' | 'ALREADY_BILLED' | 'BILLING_VOIDED' | 'SKIPPED' | 'EARLIER_UNBILLED' | 'OUTSIDE_TERM';
interface Match {
  invoice: { id: string; number: string; issueDate: string; subtotal: string; currency: string };
  contract: { id: string; ref: string; title: string };
  customer: string;
  status: 'DRAFT' | 'POSTED';
  score: number;
  confidence: 'HIGH' | 'MEDIUM';
  reasons: string[];
  period: { no: number; start: string; end: string; part: boolean } | null;
  periodState: PeriodState;
  billedBy: { id: string; number: string | null } | null;
  differences: { description: string; billed: { quantity: string; unitPrice: string }; contract: { quantity: string; unitPrice: string }; difference: string }[];
  missingLines: string[];
  totalDifference: string | null;
  canLink: boolean;
  advice: string;
}
interface Report {
  matches: Match[];
  summary: { matches: number; billedTwice: number; toLink: number; priceDifferences: number };
  contracts: number;
  dismissed: number;
  canManage: boolean;
}
const STATE: Record<PeriodState, { label: string; tone: 'negative' | 'warning' | 'accent' | 'neutral' }> = {
  ALREADY_BILLED: { label: 'Billed twice?', tone: 'negative' },
  NEXT: { label: 'Next period', tone: 'accent' },
  EARLIER_UNBILLED: { label: 'Earlier periods unbilled', tone: 'warning' },
  BILLING_VOIDED: { label: 'Contract invoice voided', tone: 'neutral' },
  SKIPPED: { label: 'Period was skipped', tone: 'warning' },
  OUTSIDE_TERM: { label: 'Outside the term', tone: 'warning' },
};

/** Sales → Contract matching (AR-041): invoices raised by hand, matched to the contract they bill. */
export default function ContractMatchingPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const key = ['contract-matching', orgId];
  const base = `/v1/orgs/${orgId}/sales/contract-matching`;
  const q = useQuery({ queryKey: key, queryFn: () => api<Report>(base) });
  const link = useMutation({ mutationFn: (m: Match) => api<Report>(`${base}/link`, { method: 'POST', body: { documentId: m.invoice.id, contractId: m.contract.id } }), onSuccess: (r) => qc.setQueryData(key, r) });
  const [dismissing, setDismissing] = useState<Match | null>(null);
  if (!org) return null;
  const r = q.data;
  return (
    <>
      <PageHeader title="Contract matching" description="Invoices raised by hand to customers with contracts, each matched to the contract it most likely bills: by its lines, prices and total, and its date in the contract's term. It shows the period each one falls in, any period billed twice and any price that differs from the contract. Nothing changes until you count an invoice as a period or dismiss the match." />
      <ErrorAlert title="Could not match invoices to contracts" error={q.error} />
      <ErrorAlert title="The invoice was not counted as the period" error={link.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-4"><p className="text-sm text-fg-muted">Matched invoices</p><p className="mt-1 text-2xl font-semibold">{r.summary.matches}</p><p className="text-xs text-fg-muted">Against {r.contracts} contract{r.contracts === 1 ? '' : 's'}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Billed twice?</p><p className="mt-1 text-2xl font-semibold text-negative">{r.summary.billedTwice}</p><p className="text-xs text-fg-muted">Periods the contract billed already</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">To count as a period</p><p className="mt-1 text-2xl font-semibold">{r.summary.toLink}</p><p className="text-xs text-fg-muted">So the contract does not bill them again</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Prices differ</p><p className="mt-1 text-2xl font-semibold">{r.summary.priceDifferences}</p><p className="text-xs text-fg-muted">{r.dismissed} match{r.dismissed === 1 ? '' : 'es'} dismissed</p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Invoices matched to contracts">
          <CardHeader title="Invoices matched to contracts" description="Possible double billing first, then invoices to count as the contract's next period. Open the invoice or the contract to check them." />
          {r.matches.length ? (
            <Table aria-label="Invoices matched to contracts">
              <thead><Tr><Th>Invoice</Th><Th>Contract and period</Th><Th>What was found</Th><Th numeric>Before tax</Th><Th><span className="sr-only">Actions</span></Th></Tr></thead>
              <tbody>
                {r.matches.map((m) => (
                  <Tr key={`${m.invoice.id}:${m.contract.id}`}>
                    <Td className="align-top">
                      <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${m.invoice.id}`} prefetch={false}>{m.invoice.number}</Link>
                      <span className="block text-sm">{m.customer}</span>
                      <span className="block text-xs text-fg-muted">{date(m.invoice.issueDate)}{m.status === 'DRAFT' ? ' · draft' : ''}</span>
                    </Td>
                    <Td className="align-top">
                      <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/contracts/${m.contract.id}`} prefetch={false}>{m.contract.ref}</Link> <span className="text-sm">{m.contract.title}</span>
                      <span className="block text-xs text-fg-muted">{m.period ? `Period ${m.period.no}: ${date(m.period.start)} to ${date(m.period.end)}` : 'No period'}</span>
                      <span className="mt-1 flex flex-wrap gap-1"><Badge tone={STATE[m.periodState].tone}>{STATE[m.periodState].label}</Badge><Badge tone={m.confidence === 'HIGH' ? 'positive' : 'neutral'}>{m.confidence === 'HIGH' ? 'Strong match' : 'Possible match'} · {m.score}</Badge></span>
                    </Td>
                    <Td className="align-top">
                      <p className="max-w-xl text-sm">{m.advice}</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-fg-muted">{m.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
                      {m.differences.length ? (
                        <ul className="mt-1 text-xs" aria-label={`Price differences on ${m.invoice.number}`}>
                          {m.differences.map((d) => (
                            <li key={d.description}>{d.description}: billed {d.billed.quantity} × <Money value={d.billed.unitPrice} currency={m.invoice.currency} />, contract {d.contract.quantity} × <Money value={d.contract.unitPrice} currency={m.invoice.currency} /> (<span className={d.difference.startsWith('-') ? 'text-negative' : 'text-warning'}><Money value={d.difference} currency={m.invoice.currency} signed /></span>)</li>
                          ))}
                        </ul>
                      ) : null}
                      {m.missingLines.length ? <p className="mt-1 text-xs">Not on the invoice: {m.missingLines.join(', ')}</p> : null}
                    </Td>
                    <Td numeric className="align-top">
                      <Money value={m.invoice.subtotal} currency={m.invoice.currency} />
                      {m.totalDifference && m.totalDifference !== '0.00' && !/^-?0(\.0+)?$/.test(m.totalDifference) ? <span className="block text-xs text-fg-muted">vs contract <Money value={m.totalDifference} currency={m.invoice.currency} signed /></span> : null}
                    </Td>
                    <Td className="align-top">
                      {r.canManage ? (
                        <div className="flex flex-col items-end gap-1">
                          {m.canLink ? <Button size="sm" loading={link.isPending && link.variables?.invoice.id === m.invoice.id} onClick={() => link.mutate(m)}>Count as period {m.period!.no}</Button> : null}
                          <Button size="sm" variant="ghost" onClick={() => setDismissing(m)}>Not this contract</Button>
                        </div>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title={r.contracts ? 'No invoice to match' : 'No contracts yet'}>{r.contracts ? 'Every invoice to a customer with a contract was made by the contract, or is not like any contract.' : 'Invoices are matched once customers have active contracts.'}</EmptyState>
          )}
        </Card>
      ) : null}
      {dismissing ? <DismissDialog base={base} match={dismissing} onClose={() => setDismissing(null)} onDone={(x) => { qc.setQueryData(key, x); setDismissing(null); }} /> : null}
    </>
  );
}

function DismissDialog({ base, match, onClose, onDone }: { base: string; match: Match; onClose: () => void; onDone: (r: Report) => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api<Report>(`${base}/dismiss`, { method: 'POST', body: { documentId: match.invoice.id, contractId: match.contract.id, reason } }), onSuccess: onDone });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${match.invoice.number} does not bill ${match.contract.ref}`} description="Say why, for the record. This pair is not suggested again.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.error ? <Alert title="Could not dismiss the match">{save.error.message}</Alert> : null}
        <Field label="Why">{(p) => <Textarea {...p} rows={2} minLength={3} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Dismiss match</Button></div>
      </form>
    </Dialog>
  );
}
