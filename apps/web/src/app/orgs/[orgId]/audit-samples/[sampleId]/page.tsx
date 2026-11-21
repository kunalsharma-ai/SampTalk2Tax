'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { itemHref, METHODS, REASONS, type Sample } from '@/components/controls/samples';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** One audit sample: the items picked, why each was picked, and the result of testing each. */
export default function SamplePage() {
  const { org, orgId } = useOrg();
  const { sampleId } = useParams<{ sampleId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/audit-samples/${sampleId}`;
  const key = ['audit-sample', orgId, sampleId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Sample>(base) });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const record = useMutation({
    mutationFn: (v: { refId: string; result: 'OK' | 'EXCEPTION' }) => api<Sample>(`${base}/items/${v.refId}/result`, { method: 'POST', body: { result: v.result, note: notes[v.refId]?.trim() || null } }),
    onSuccess: (s) => {
      qc.setQueryData(key, s);
      void qc.invalidateQueries({ queryKey: ['audit-samples', orgId] });
    },
  });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the sample" error={q.error} />;
  const s = q.data;
  if (!s) return null;
  const cur = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title={`${s.reference}: ${s.name}`}
        description={<>{s.populationLabel} dated {date(s.from)} to {date(s.to)}, {METHODS[s.method].label.toLowerCase()} sampling. Drawn by {s.createdBy.name} on {date(s.createdAt.slice(0, 10))}. <Link className="text-accent" href={`/orgs/${orgId}/audit-samples`}>All samples</Link></>}
        actions={<Badge tone={s.status === 'COMPLETED' ? 'positive' : 'warning'}>{s.status === 'COMPLETED' ? 'Completed' : 'Testing'}</Badge>}
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Stat label="Population" value={s.populationCount} sub={money(s.populationTotal, cur)} />
        <Stat label="Picked" value={s.items.length} sub={s.interval ? `Interval ${money(s.interval, cur)}` : s.threshold ? `Threshold ${money(s.threshold, cur)}` : `Asked for ${s.size}`} />
        <Stat label="Tested" value={`${s.progress.tested} of ${s.items.length}`} tone={s.progress.remaining ? 'warning' : 'positive'} />
        <Stat label="Exceptions" value={s.progress.exceptions} tone={s.progress.exceptions ? 'negative' : 'neutral'} />
      </div>
      <Card className="mb-4">
        <CardHeader title="Draw it again" description={`Seed: ${s.seed}`} />
        <div className="p-4 text-sm">
          {s.populationChanged ? (
            <Alert tone="warning" title="The books changed since this sample was drawn">Items were posted, voided or changed in the range. {s.redrawMatches ? 'Drawing again from the seed still picks the same items.' : 'Drawing again from the seed would now pick different items; the sample keeps what was drawn.'}</Alert>
          ) : (
            <p aria-label="Redraw check">The population is as it was, and drawing again from the seed picks the same {s.items.length} items.</p>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Sampled items" description="Open each item, test it, then record whether it was right. Each result is kept as recorded." />
        <Table aria-label="Sampled items">
          <thead><Tr><Th>Item</Th><Th>Date</Th><Th className="text-right">Amount</Th><Th>Picked as</Th><Th>Result</Th></Tr></thead>
          <tbody>
            {s.items.map((i) => (
              <Tr key={i.refId}>
                <Td><Link className="hover:text-accent" href={itemHref(orgId, s.population, i.refId)}>{i.label}</Link></Td>
                <Td className="whitespace-nowrap">{date(i.date)}</Td>
                <Td className="num text-right">{money(i.amount, cur)}</Td>
                <Td className="text-sm">{REASONS[i.reason]}</Td>
                <Td className="text-sm">
                  {i.result ? (
                    <>
                      <Badge tone={i.result === 'OK' ? 'positive' : 'negative'}>{i.result === 'OK' ? 'No exception' : 'Exception'}</Badge>
                      {i.note ? <div className="text-fg-muted">{i.note}</div> : null}
                      <div className="text-xs text-fg-muted">{i.testedBy?.name}, {dateTime(i.testedAt ?? '')}</div>
                    </>
                  ) : s.status === 'OPEN' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input aria-label={`Note for ${i.label}`} className="w-56" maxLength={1000} value={notes[i.refId] ?? ''} onChange={(e) => setNotes({ ...notes, [i.refId]: e.target.value })} placeholder="What you found (needed for an exception)" />
                      <Button size="sm" variant="secondary" loading={record.isPending && record.variables?.refId === i.refId && record.variables.result === 'OK'} onClick={() => record.mutate({ refId: i.refId, result: 'OK' })}>No exception</Button>
                      <Button size="sm" variant="secondary" disabled={(notes[i.refId]?.trim().length ?? 0) < 10} loading={record.isPending && record.variables?.refId === i.refId && record.variables.result === 'EXCEPTION'} onClick={() => record.mutate({ refId: i.refId, result: 'EXCEPTION' })}>Exception</Button>
                    </div>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        <div className="p-4"><ErrorAlert title="The result was not recorded" error={record.error} /></div>
      </Card>
      {s.status === 'COMPLETED' ? <p className="mt-4 text-sm text-fg-muted">Completed on {date((s.completedAt ?? '').slice(0, 10))}. A completed sample is kept as it was completed. <Link className="text-accent" href={`/orgs/${orgId}/audit-findings`}>Raise an audit finding</Link> for any exception that needs fixing.</p> : null}
    </>
  );
}
