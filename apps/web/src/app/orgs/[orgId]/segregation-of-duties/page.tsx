'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { DateInput } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Person = { id: string; name: string };
interface Finding {
  key: string;
  rule: string;
  ruleTitle: string;
  date: string;
  people: Person[];
  involvesMe: boolean;
  subject: { type: 'journal' | 'bill' | 'payment_batch' | 'payment' | 'bank_reconciliation'; id: string; label: string };
  detail: string;
  amount: string | null;
  review: { reason: string; by: Person; at: string } | null;
}
interface Overview {
  from: string;
  to: string;
  findings: Finding[];
  rules: { id: string; title: string; why: string; open: number; reviewed: number }[];
  members: (Person & { role: string; conflicts: { id: string; title: string }[] })[];
  reviewers: number;
  canReview: boolean;
}

const minus = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const LINKS: Record<Finding['subject']['type'], ((id: string) => string) | null> = {
  journal: (id) => `journals/${id}`,
  bill: (id) => `purchases/bills/${id}`,
  payment_batch: (id) => `purchases/payment-batches/${id}`,
  payment: (id) => `purchases/payments/${id}`,
  bank_reconciliation: null,
};

/** Segregation-of-duties checks (AUDIT-014): one person doing two jobs that should be split. */
export default function SegregationOfDutiesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => minus(today(), 89));
  const [openOnly, setOpenOnly] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const bad = from > to;
  const key = ['segregation-of-duties', orgId, from, to];
  const q = useQuery({ queryKey: key, enabled: !bad, queryFn: () => api<Overview>(`/v1/orgs/${orgId}/segregation-of-duties?from=${from}&to=${to}`) });
  const review = useMutation({
    mutationFn: (f: Finding) => api(`/v1/orgs/${orgId}/segregation-of-duties/reviews`, { method: 'POST', body: { key: f.key, date: f.date, reason } }),
    onSuccess: () => {
      setReviewing(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['segregation-of-duties', orgId] });
    },
  });
  if (!org) return null;
  const d = q.data;
  const shown = d ? d.findings.filter((f) => !openOnly || !f.review) : [];
  const open = d ? d.findings.filter((f) => !f.review).length : 0;
  const withConflicts = d ? d.members.filter((m) => m.conflicts.length).length : 0;
  return (
    <>
      <PageHeader
        title="Segregation of duties"
        description="Places where one person did two jobs that should be split, such as writing a journal and posting it, or changing a vendor's bank details and then paying them. Nothing here changes the books."
        actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /></>}
      />
      {bad ? <Alert tone="warning" title="Check the dates">The start date is after the end date.</Alert> : null}
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat label="Open findings" value={open} sub={`${date(d.from)} to ${date(d.to)}`} tone={open ? 'warning' : 'positive'} />
            <Stat label="Reviewed" value={d.findings.length - open} sub="Cleared by someone not involved" />
            <Stat label="Members with conflicting duties" value={withConflicts} sub={`of ${d.members.length} who can change the books`} tone={withConflicts ? 'warning' : 'neutral'} />
          </div>
          {d.reviewers < 2 ? (
            <Alert tone="warning" title="Few people to review">
              Only {d.reviewers === 1 ? 'one member' : 'no one'} can clear findings, and no one can clear a finding they were involved in. Add an approver, such as your outside accountant, so someone independent can review.
            </Alert>
          ) : null}
          <Card className="mb-4">
            <CardHeader
              title="Segregation findings"
              description="Newest first. Open the record to see what happened, then clear it with the reason it is fine."
              actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />Open only</label>}
            />
            {!shown.length ? (
              <EmptyState title={d.findings.length ? 'Every finding is reviewed' : 'No findings in these dates'}>{d.findings.length ? 'Untick Open only to see the reviews.' : 'Each job in these dates was split between people.'}</EmptyState>
            ) : (
              <Table aria-label="Segregation findings">
                <thead><Tr><Th>Date</Th><Th>Check</Th><Th>Record</Th><Th>Who</Th><Th numeric>Amount</Th><Th>Review</Th></Tr></thead>
                <tbody>
                  {shown.map((f) => {
                    const link = LINKS[f.subject.type];
                    return (
                      <Tr key={f.key}>
                        <Td className="whitespace-nowrap">{date(f.date)}</Td>
                        <Td><div>{f.ruleTitle}</div>{f.detail ? <div className="text-xs text-fg-muted">{f.detail}</div> : null}</Td>
                        <Td>{link ? <Link className="hover:text-accent" href={`/orgs/${orgId}/${link(f.subject.id)}`}>{f.subject.label}</Link> : f.subject.label}</Td>
                        <Td>{f.people.map((p) => p.name).join(', ')}</Td>
                        <Td numeric>{f.amount ? <Money value={f.amount} currency={org.functionalCurrency} /> : '—'}</Td>
                        <Td className="w-1/3">
                          {f.review ? (
                            <div className="text-sm"><Badge tone="positive">Reviewed</Badge> <span className="text-fg-muted">by {f.review.by.name} on {date(f.review.at.slice(0, 10))}:</span> {f.review.reason}</div>
                          ) : reviewing === f.key ? (
                            <form
                              className="flex flex-col gap-2"
                              onSubmit={(e) => {
                                e.preventDefault();
                                review.mutate(f);
                              }}
                            >
                              <Textarea aria-label={`Why ${f.subject.label} is fine`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What you checked and why it is fine" />
                              <div className="flex gap-2">
                                <Button type="submit" size="sm" disabled={reason.trim().length < 10} loading={review.isPending}>Clear finding</Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setReviewing(null)}>Cancel</Button>
                              </div>
                            </form>
                          ) : d.canReview && !f.involvesMe ? (
                            <Button size="sm" variant="secondary" aria-label={`Review ${f.subject.label}`} onClick={() => { setReviewing(f.key); setReason(''); review.reset(); }}>Review</Button>
                          ) : (
                            <span className="text-xs text-fg-muted">{f.involvesMe ? 'Someone else must review this' : 'Waiting for an approver'}</span>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
            <ErrorAlert title="The finding was not cleared" error={review.error} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Segregation checks" description="What is looked for, and why it matters" />
              <Table>
                <thead><Tr><Th>Check</Th><Th numeric>Open</Th><Th numeric>Reviewed</Th></Tr></thead>
                <tbody>
                  {d.rules.map((r) => (
                    <Tr key={r.id}>
                      <Td><div>{r.title}</div><div className="text-xs text-fg-muted">{r.why}</div></Td>
                      <Td numeric>{r.open}</Td>
                      <Td numeric>{r.reviewed}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title="Conflicting duties by member" description="Duties each member's role lets them do together" />
              <Table aria-label="Conflicting duties">
                <thead><Tr><Th>Member</Th><Th>Role</Th><Th>Duties held together</Th></Tr></thead>
                <tbody>
                  {d.members.map((m) => (
                    <Tr key={m.id}>
                      <Td>{m.name}</Td>
                      <Td className="text-fg-muted">{m.role.charAt(0) + m.role.slice(1).toLowerCase()}</Td>
                      <Td>{m.conflicts.length ? m.conflicts.map((c) => <Badge key={c.id} tone="warning" className="mb-1 mr-1">{c.title}</Badge>) : <span className="text-fg-muted">None</span>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
