'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { acct, METHOD, monthName, shortMonth, type AssetAccounts, type AssetDetail, type EntryRef } from '@/lib/fixed-assets';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export default function AssetPage() {
  const { org, orgId } = useOrg();
  const { assetId } = useParams<{ assetId: string }>();
  const qc = useQueryClient();
  const key = ['fixed-asset', orgId, assetId];
  const q = useQuery({ queryKey: key, queryFn: () => api<AssetDetail>(`/v1/orgs/${orgId}/fixed-assets/${assetId}`) });
  if (!org) return null;
  const a = q.data;
  const cur = org.functionalCurrency;
  const je = (e: EntryRef, label = 'Journal') => (e ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>{label} #{e.entryNumber}</Link> : null);
  return (
    <>
      <PageHeader
        title={a ? `${a.reference} ${a.name}` : 'Asset'}
        description={a ? [a.category, a.location, a.serialNumber ? `Serial ${a.serialNumber}` : null].filter(Boolean).join(' · ') || undefined : undefined}
        actions={a?.can.manage && a.status === 'ACTIVE' ? <Link href={`/orgs/${orgId}/fixed-assets/${assetId}/edit`}><Button variant="secondary">Change…</Button></Link> : undefined}
      />
      <ErrorAlert title="Could not load the asset" error={q.error} />
      {a ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Cost" value={<Money value={a.cost} currency={cur} />} sub={`Acquired ${date(a.acquisitionDate)}`} />
            <Stat label="Accumulated depreciation" value={<Money value={a.accumulated} currency={cur} />} sub={Number(a.openingAccumulated) > 0 ? `Includes ${a.openingAccumulated} brought in` : undefined} />
            <Stat label="Net book value" value={<Money value={a.netBookValue} currency={cur} />} tone={a.status === 'DISPOSED' ? 'neutral' : 'positive'} sub={a.status === 'DISPOSED' ? 'Disposed of' : `Residual value ${a.residualValue}`} />
            <Stat label={a.status === 'DISPOSED' ? 'Status' : 'Fully depreciated in'} value={a.status === 'DISPOSED' ? <Badge>Disposed of</Badge> : a.fullyDepreciatedIn ? shortMonth(a.fullyDepreciatedIn) : '—'} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="p-4 xl:col-span-1">
              <CardHeader title="Terms" />
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-fg-muted">Method</dt>
                <dd>{METHOD[a.method]}{a.method === 'STRAIGHT_LINE' ? `, ${a.usefulLifeMonths} months` : `, ${a.annualRate}% a year`}</dd>
                <dt className="text-fg-muted">Put to use</dt>
                <dd>{date(a.inServiceDate)}</dd>
                <dt className="text-fg-muted">Asset account</dt>
                <dd>{acct(a.accounts.asset)}</dd>
                <dt className="text-fg-muted">Accumulated depreciation</dt>
                <dd>{acct(a.accounts.accumulated)}</dd>
                <dt className="text-fg-muted">Depreciation expense</dt>
                <dd>{acct(a.accounts.expense)}</dd>
                {a.depreciatedThrough ? (
                  <>
                    <dt className="text-fg-muted">Brought in</dt>
                    <dd>{a.openingAccumulated} depreciated to {monthName(a.depreciatedThrough)}</dd>
                  </>
                ) : null}
                <dt className="text-fg-muted">Purchase</dt>
                <dd>{je(a.acquisitionEntry) ?? 'Not posted here'}</dd>
                <dt className="text-fg-muted">Added by</dt>
                <dd>{a.createdBy}</dd>
              </dl>
            </Card>
            <Card className="overflow-x-auto xl:col-span-2">
              <div className="p-4 pb-0"><CardHeader title="Depreciation schedule" description="Posted months, then the next twelve. A posted month keeps the amount posted." /></div>
              <Table aria-label="Depreciation schedule">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th numeric>Charge</Th>
                    <Th numeric>Accumulated</Th>
                    <Th numeric>Net book value</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.schedule.map((r) => {
                    const p = a.postings.find((x) => x.month === r.month && x.runStatus === 'POSTED');
                    return (
                      <Tr key={r.month}>
                        <Td>{shortMonth(r.month)}</Td>
                        <Td numeric><Money value={r.charge} currency={cur} /></Td>
                        <Td numeric><Money value={r.accumulated} currency={cur} /></Td>
                        <Td numeric><Money value={r.netBookValue} currency={cur} /></Td>
                        <Td>{r.posted ? <span className="text-sm">Posted {p ? <>in {je(p.entry)}{p.runMonth !== r.month ? ` (${shortMonth(p.runMonth)} run)` : ''}</> : null}</span> : <span className="text-sm text-fg-faint">To come</span>}</Td>
                      </Tr>
                    );
                  })}
                  {!a.schedule.length ? <Tr><Td colSpan={5} className="text-fg-muted">Nothing left to depreciate.</Td></Tr> : null}
                </tbody>
              </Table>
            </Card>
          </div>
          {a.disposal ? (
            <Card className="mt-4 p-4" aria-label="Disposal">
              <CardHeader title={`Disposed of on ${date(a.disposal.date)}`} />
              <p className="mt-2 text-sm">
                Proceeds <Money value={a.disposal.proceeds} currency={cur} /> · by {a.disposal.by} · {je(a.disposal.entry)}
                {a.disposal.note ? <span className="block text-fg-muted">{a.disposal.note}</span> : null}
              </p>
            </Card>
          ) : a.can.manage ? (
            <DisposeCard a={a} orgId={orgId} cur={cur} onDone={(x) => { qc.setQueryData(key, x); void qc.invalidateQueries({ queryKey: ['fixed-assets', orgId] }); }} />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function DisposeCard({ a, orgId, cur, onDone }: { a: AssetDetail; orgId: string; cur: string; onDone: (a: AssetDetail) => void }) {
  const [open, setOpen] = useState(false);
  const accounts = useQuery({ queryKey: ['asset-accounts', orgId], queryFn: () => api<AssetAccounts>(`/v1/orgs/${orgId}/fixed-assets/accounts`), enabled: open });
  const [f, setF] = useState({ date: today(), proceeds: '0.00', proceedsAccountId: '', gainLossAccountId: '', note: '' });
  const acc = accounts.data;
  const proceedsAcc = f.proceedsAccountId || acc?.funding.find((x) => x.code === '1120')?.id || acc?.funding[0]?.id || '';
  const glAcc = f.gainLossAccountId || acc?.gainLoss.find((x) => x.code === '4900')?.id || acc?.gainLoss[0]?.id || '';
  const proceeds = Number(f.proceeds.replace(/,/g, '') || 0);
  const nbv = Number(a.netBookValue);
  const gain = proceeds - nbv;
  const dispose = useMutation({
    mutationFn: () => api<AssetDetail>(`/v1/orgs/${orgId}/fixed-assets/${a.id}/dispose`, { method: 'POST', body: { date: f.date, proceeds: f.proceeds.replace(/,/g, '') || '0', proceedsAccountId: proceeds > 0 ? proceedsAcc : null, gainLossAccountId: glAcc, note: f.note || null } }),
    onSuccess: (x) => { setOpen(false); onDone(x); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Card className="mt-4 p-4" aria-label="Dispose of this asset">
      <CardHeader title="Sold, scrapped or written off?" description="Disposing takes the asset off the books: proceeds in, cost and accumulated depreciation out, and the difference to a gain or loss. Depreciation must be posted through the month of disposal." actions={!open ? <Button variant="secondary" onClick={() => setOpen(true)}>Dispose of…</Button> : undefined} />
      {open ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Disposed of on">{(p) => <Input {...p} type="date" value={f.date} onChange={set('date')} />}</Field>
            <Field label="Proceeds" hint="0 if scrapped">{(p) => <Input {...p} inputMode="decimal" value={f.proceeds} onChange={set('proceeds')} />}</Field>
            {proceeds > 0 ? <Field label="Received into">{(p) => <Select {...p} value={proceedsAcc} onChange={set('proceedsAccountId')}>{acc?.funding.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field> : null}
            <Field label="Gain or loss to">{(p) => <Select {...p} value={glAcc} onChange={set('gainLossAccountId')}>{acc?.gainLoss.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
          </div>
          <Field label="Note (optional)">{(p) => <Input {...p} value={f.note} onChange={set('note')} maxLength={500} />}</Field>
          <p className="text-sm" role="status">
            Net book value now <Money value={a.netBookValue} currency={cur} />: a {gain >= 0 ? 'gain' : 'loss'} of <Money value={Math.abs(gain).toFixed(2)} currency={cur} /> (once depreciation is posted through the disposal month).
          </p>
          <ErrorAlert title="Not disposed of" error={dispose.error} />
          <div className="flex gap-2">
            <Button variant="danger" loading={dispose.isPending} disabled={!glAcc} onClick={() => dispose.mutate()}>Dispose of {a.reference}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
