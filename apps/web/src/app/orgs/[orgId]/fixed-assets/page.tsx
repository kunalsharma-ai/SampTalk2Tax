'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { METHOD, shortMonth, type Register } from '@/lib/fixed-assets';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function FixedAssetsPage() {
  const { org, orgId } = useOrg();
  const [status, setStatus] = useState<'ACTIVE' | 'DISPOSED' | ''>('ACTIVE');
  const q = useQuery({ queryKey: ['fixed-assets', orgId], queryFn: () => api<Register>(`/v1/orgs/${orgId}/fixed-assets`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = q.data;
  const rows = (r?.assets ?? []).filter((a) => !status || a.status === status);
  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="The register of what the business owns for longer than a year: cost, depreciation to date and net book value, worked out from the posted depreciation. Depreciation is posted once a month as one journal."
        actions={
          <div className="flex gap-2">
            <Link href={`/orgs/${orgId}/fixed-assets/depreciation`}><Button variant="secondary">Depreciation</Button></Link>
            {r?.can.manage ? <Link href={`/orgs/${orgId}/fixed-assets/new`}><Button>Add asset</Button></Link> : null}
          </div>
        }
      />
      <ErrorAlert title="Could not load the register" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Assets in use" value={r.totals.active} tone="accent" sub={r.totals.disposed ? `${r.totals.disposed} disposed of` : undefined} />
            <Stat label="Cost" value={<Money value={r.totals.cost} currency={cur} />} sub="Assets in use" />
            <Stat label="Accumulated depreciation" value={<Money value={r.totals.accumulated} currency={cur} />} />
            <Stat label="Net book value" value={<Money value={r.totals.netBookValue} currency={cur} />} tone="positive" />
          </div>
          <label className="mb-3 flex w-fit items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Show
            <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="ACTIVE">In use</option>
              <option value="DISPOSED">Disposed of</option>
              <option value="">All</option>
            </Select>
          </label>
          {rows.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Fixed asset register">
                <thead>
                  <tr>
                    <Th>Asset</Th>
                    <Th>Category</Th>
                    <Th>In use since</Th>
                    <Th>Method</Th>
                    <Th numeric>Cost</Th>
                    <Th numeric>Accumulated depreciation</Th>
                    <Th numeric>Net book value</Th>
                    <Th>Depreciated to</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <Tr key={a.id}>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/fixed-assets/${a.id}`}>{a.reference} {a.name}</Link>
                        {a.location ? <span className="block text-xs text-fg-faint">{a.location}</span> : null}
                      </Td>
                      <Td>{a.category ?? '—'}</Td>
                      <Td className="whitespace-nowrap">{date(a.inServiceDate)}</Td>
                      <Td>{METHOD[a.method]}</Td>
                      <Td numeric><Money value={a.cost} currency={cur} /></Td>
                      <Td numeric><Money value={a.accumulated} currency={cur} /></Td>
                      <Td numeric><Money value={a.netBookValue} currency={cur} /></Td>
                      <Td className="whitespace-nowrap">{a.status === 'DISPOSED' ? <Badge>Disposed {date(a.disposedOn!)}</Badge> : a.depreciatedThrough ? shortMonth(a.depreciatedThrough) : 'Not yet'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card>
              <EmptyState title={status === 'DISPOSED' ? 'Nothing disposed of' : 'No assets yet'} action={r.can.manage && status !== 'DISPOSED' ? <Link href={`/orgs/${orgId}/fixed-assets/new`}><Button>Add asset</Button></Link> : undefined}>
                Add equipment, vehicles, computers and other long-lived assets to depreciate them each month.
              </EmptyState>
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
