'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/collections';
import { shortMonth, type DepreciationView } from '@/lib/fixed-assets';
import { useOrg } from '@/lib/org';

export default function DepreciationPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/fixed-assets/depreciation`;
  const [month, setMonth] = useState<string>('');
  const q = useQuery({ queryKey: ['depreciation', orgId, month], queryFn: () => api<DepreciationView>(`${base}${month ? `?month=${month}` : ''}`) });
  const done = (v: DepreciationView) => {
    setMonth('');
    qc.setQueryData(['depreciation', orgId, ''], v);
    void qc.invalidateQueries({ queryKey: ['fixed-assets', orgId] });
    void qc.invalidateQueries({ queryKey: ['fixed-asset', orgId] });
  };
  const run = useMutation({ mutationFn: (m: string) => api<DepreciationView>(`${base}/runs`, { method: 'POST', body: { month: m } }), onSuccess: done });
  const reverse = useMutation({ mutationFn: (id: string) => api<DepreciationView>(`${base}/runs/${id}/reverse`, { method: 'POST' }), onSuccess: done });
  if (!org) return null;
  const v = q.data;
  const cur = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Depreciation"
        description="Each month's depreciation for every asset in use, posted as one journal on the last day of the month (debit depreciation expense, credit accumulated depreciation). Months are posted in order; a month that was missed is caught up in the next run."
        actions={<Link href={`/orgs/${orgId}/fixed-assets`}><Button variant="secondary">Register</Button></Link>}
      />
      <ErrorAlert title="Could not load depreciation" error={q.error} />
      {v ? (
        <>
          <Card className="mb-4 p-4" aria-label="Post depreciation">
            <CardHeader
              title={v.month ? `Depreciation for ${v.monthName}` : 'Nothing to post'}
              description={v.lastPosted ? `Posted through ${shortMonth(v.lastPosted)}.` : 'Nothing posted yet.'}
              actions={
                <Field label="Month">
                  {(p) => <Input {...p} type="month" className="w-44" value={month || v.month || ''} max={v.currentMonth} onChange={(e) => setMonth(e.target.value)} />}
                </Field>
              }
            />
            {v.month ? (
              <div className="mt-3 flex flex-col gap-3">
                {v.period && v.period.status !== 'OPEN' ? <Alert tone="warning" title={`${v.period.name} is ${v.period.status.toLowerCase()}`}>Depreciation cannot be posted into a locked or closed period.</Alert> : null}
                {v.alreadyPosted ? <Alert tone="neutral" title="Already posted">This month has been posted. Reverse it below to post it again.</Alert> : null}
                {v.preview.length ? (
                  <Table aria-label="Depreciation to post">
                    <thead>
                      <tr>
                        <Th>Asset</Th>
                        <Th>For</Th>
                        <Th numeric>Charge</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.preview.map((l) => (
                        <Tr key={`${l.assetId}-${l.month}`}>
                          <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/fixed-assets/${l.assetId}`}>{l.reference} {l.name}</Link></Td>
                          <Td>{shortMonth(l.month)}{l.catchUp ? <Badge className="ml-2" tone="warning">Catch-up</Badge> : null}</Td>
                          <Td numeric><Money value={l.amount} currency={cur} /></Td>
                        </Tr>
                      ))}
                      <Tr>
                        <Td className="font-semibold">Total</Td>
                        <Td />
                        <Td numeric className="font-semibold"><Money value={v.previewTotal} currency={cur} /></Td>
                      </Tr>
                    </tbody>
                  </Table>
                ) : !v.alreadyPosted ? (
                  <p className="text-sm text-fg-muted">No depreciation is due for this month.</p>
                ) : null}
                <ErrorAlert title="Not posted" error={run.error} />
                {v.can.manage && v.preview.length && !v.alreadyPosted ? (
                  <div>
                    <Button loading={run.isPending} onClick={() => run.mutate(v.month!)}>Post depreciation for {v.monthName}</Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">{v.lastPosted ? 'Depreciation is posted up to this month. The next month can be posted once it starts.' : 'Add assets to the register to depreciate them.'}</p>
            )}
          </Card>
          <ErrorAlert title="Not reversed" error={reverse.error} />
          {v.runs.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Depreciation runs">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th numeric>Total</Th>
                    <Th numeric>Lines</Th>
                    <Th>Journal</Th>
                    <Th>Posted</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {v.runs.map((r) => (
                    <Tr key={r.id}>
                      <Td>{r.monthName}</Td>
                      <Td numeric><Money value={r.total} currency={cur} /></Td>
                      <Td numeric>{r.lines}</Td>
                      <Td>
                        {r.entry ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${r.entry.id}`}>#{r.entry.entryNumber}</Link> : null}
                        {r.reversal ? <> · reversed by <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${r.reversal.id}`}>#{r.reversal.entryNumber}</Link></> : null}
                      </Td>
                      <Td className="text-xs">{r.postedBy}, {dateTime(r.postedAt)}</Td>
                      <Td>{r.status === 'POSTED' ? <Badge tone="positive">Posted</Badge> : <Badge>Reversed by {r.reversedBy}</Badge>}</Td>
                      <Td>{v.can.manage && r.canReverse ? <Button size="sm" variant="ghost" loading={reverse.isPending && reverse.variables === r.id} onClick={() => reverse.mutate(r.id)}>Reverse</Button> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card><EmptyState title="No depreciation posted yet">Runs appear here once a month is posted.</EmptyState></Card>
          )}
        </>
      ) : null}
    </>
  );
}
