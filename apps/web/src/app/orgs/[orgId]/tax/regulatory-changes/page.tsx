'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Status = 'TO_REVIEW' | 'DEALT_WITH' | 'IN_FORCE';
interface Overview {
  country: string;
  today: string;
  checkedOn: string;
  staleAfterDays: number;
  rules: { key: string; title: string; checkedOn: string; page: string | null; daysSinceCheck: number; stale: boolean }[];
  changes: {
    key: string;
    effectiveOn: string;
    title: string;
    impact: string;
    inTalk2Tax: string;
    source: string;
    inDays: number;
    timing: 'UPCOMING' | 'RECENT' | 'IN_FORCE';
    status: Status;
    acknowledgement: { note: string | null; by: string; at: string } | null;
  }[];
  rateChanges: { taxRateId: string; name: string; from: string; to: string; effectiveFrom: string; reason: string }[];
  summary: { toReview: number; upcoming: number; staleRules: number; scheduledRateChanges: number };
}
const STATUS: Record<Status, { tone: 'warning' | 'positive' | 'neutral'; label: string }> = {
  TO_REVIEW: { tone: 'warning', label: 'To review' },
  DEALT_WITH: { tone: 'positive', label: 'Dealt with' },
  IN_FORCE: { tone: 'neutral', label: 'In force' },
};
const when = (days: number) => (days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : days === 0 ? 'today' : `${-days} day${days === -1 ? '' : 's'} ago`);

/** Tax → Regulatory changes (TAX-046): known law changes for your country, the rules Talk2Tax uses and when they were checked, and your scheduled rate changes. */
export default function RegulatoryChangesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const url = `/v1/orgs/${orgId}/tax/regulatory-changes`;
  const q = useQuery({ queryKey: ['regulatory-changes', orgId], queryFn: () => api<Overview>(url), enabled: !!org });
  const ack = useMutation({
    mutationFn: (key: string) => api<Overview>(`${url}/${key}/dealt-with`, { method: 'POST', body: { note: notes[key] ?? '' } }),
    onSuccess: (d) => qc.setQueryData(['regulatory-changes', orgId], d),
  });
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'accounts.manage');
  return (
    <>
      <PageHeader
        title="Regulatory changes"
        description="Known tax law changes for your country, coming up or recent, so you can prepare and record that you have; the tax rules built into Talk2Tax with when each was last checked against official sources; and your own scheduled tax rate changes. Talk2Tax does not watch government websites: the list was written by hand, is not complete, and needs review by a tax adviser."
      />
      <ErrorAlert title="Could not load regulatory changes" error={q.error} />
      {d ? (
        <>
          <Card role="region" aria-label="Law changes for your country">
            <CardHeader
              title="Law changes for your country"
              description={`${d.summary.toReview} to review, ${d.summary.upcoming} coming up. List written on ${date(d.checkedOn)}; confirm each change with the source named.`}
            />
            {d.changes.length ? (
              <Table aria-label="Law changes for your country">
                <thead>
                  <Tr>
                    <Th>Takes effect</Th>
                    <Th>Change</Th>
                    <Th>Status</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.changes.map((c) => (
                    <Tr key={c.key}>
                      <Td className="whitespace-nowrap align-top">
                        <span className="block">{date(c.effectiveOn)}</span>
                        <span className="block text-xs text-fg-muted">{when(c.inDays)}</span>
                      </Td>
                      <Td className="align-top text-sm">
                        <span className="block font-medium">{c.title}</span>
                        <span className="block">{c.impact}</span>
                        <span className="block text-fg-muted">In Talk2Tax: {c.inTalk2Tax}</span>
                        <span className="block text-xs text-fg-muted">Source: {c.source}</span>
                      </Td>
                      <Td className="align-top">
                        <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                        {c.acknowledgement ? (
                          <span className="mt-1 block text-xs text-fg-muted">
                            {c.acknowledgement.by}, {date(c.acknowledgement.at.slice(0, 10))}
                            {c.acknowledgement.note ? `: ${c.acknowledgement.note}` : ''}
                          </span>
                        ) : manage && c.status === 'TO_REVIEW' ? (
                          <form
                            className="mt-2 flex flex-col gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              ack.mutate(c.key);
                            }}
                          >
                            <Field label={`How you dealt with it (${c.key})`}>
                              {(p) => <Input {...p} maxLength={1000} value={notes[c.key] ?? ''} onChange={(e) => setNotes({ ...notes, [c.key]: e.target.value })} />}
                            </Field>
                            <Button type="submit" size="sm" variant="secondary" loading={ack.isPending && ack.variables === c.key}>
                              Mark dealt with
                            </Button>
                          </form>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No known changes for your country">Talk2Tax has no law changes listed for your country yet.</EmptyState>
            )}
            <div className="px-5 pb-4">
              <ErrorAlert title="Could not record the change" error={ack.error} />
            </div>
          </Card>

          <Card className="mt-6" role="region" aria-label="Rules Talk2Tax uses">
            <CardHeader
              title="Rules Talk2Tax uses"
              description={`The tax rules built in for your country, oldest check first. Rules not checked for more than ${d.staleAfterDays} days are marked for review.`}
            />
            <Table aria-label="Rules Talk2Tax uses">
              <thead>
                <Tr>
                  <Th>Rules</Th>
                  <Th>Last checked</Th>
                  <Th>Status</Th>
                </Tr>
              </thead>
              <tbody>
                {d.rules.map((r) => (
                  <Tr key={r.key}>
                    <Td>
                      {r.page ? (
                        <Link className="underline" href={`/orgs/${orgId}${r.page}`}>
                          {r.title}
                        </Link>
                      ) : (
                        r.title
                      )}
                    </Td>
                    <Td>
                      <span className="block">{date(r.checkedOn)}</span>
                      <span className="block text-xs text-fg-muted">{when(-r.daysSinceCheck)}</span>
                    </Td>
                    <Td>{r.stale ? <Badge tone="warning">Due for review</Badge> : <Badge tone="positive">Checked recently</Badge>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card className="mt-6" role="region" aria-label="Your scheduled rate changes">
            <CardHeader
              title="Your scheduled rate changes"
              description="New rates you have added to your tax rates with a future start date. Documents dated on or after that date use the new rate."
            />
            {d.rateChanges.length ? (
              <Table aria-label="Your scheduled rate changes">
                <thead>
                  <Tr>
                    <Th>Tax rate</Th>
                    <Th>From</Th>
                    <Th>Change</Th>
                    <Th>Reason</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.rateChanges.map((r) => (
                    <Tr key={r.taxRateId + r.effectiveFrom}>
                      <Td>
                        <Link className="underline" href={`/orgs/${orgId}/settings/tax-rates/${r.taxRateId}`}>
                          {r.name}
                        </Link>
                      </Td>
                      <Td>{date(r.effectiveFrom)}</Td>
                      <Td>
                        {r.from}% to {r.to}%
                      </Td>
                      <Td className="text-sm">{r.reason}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No rate changes scheduled">Add a new rate with a start date on a tax rate when the law changes it.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
