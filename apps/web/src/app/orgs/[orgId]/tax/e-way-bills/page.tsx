'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, EmptyState, Stat, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { istTime } from '@/components/e-invoice';
import { EWB_STATE } from '@/components/e-way-bill';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useEWayBillSettings, useOrg } from '@/lib/org';
import type { EWayBillRegister, EWayBillRow } from '@/lib/types';

const monthStart = (iso: string, shift = 0) => {
  const d = new Date(Date.parse(`${iso.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() + shift);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (iso: string) => new Date(Date.parse(monthStart(iso, 1)) - 86_400_000).toISOString().slice(0, 10);
const monthName = (iso: string) => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function EWayBillsPage() {
  return (
    <Suspense>
      <EWayBills />
    </Suspense>
  );
}

function Details({ x }: { x: EWayBillRow }) {
  const b = x.eWayBill;
  if (x.state !== 'GENERATED' || !b) return <>{x.reason}</>;
  return (
    <>
      <span className="num text-fg">{b.number}</span>
      {b.partB?.vehicleNo ? <> · <span className="num">{b.partB.vehicleNo}</span></> : null}
      {' · '}
      {b.validUntil ? (b.expired ? <span className="text-negative">expired {istTime(b.validUntil)}</span> : <>valid until {istTime(b.validUntil)}</>) : <span className="text-warning">Part A only</span>}
    </>
  );
}

function EWayBills() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const month = params.get('month') ?? today().slice(0, 7);
  const from = `${month}-01`;
  const to = monthEnd(from);
  const settings = useEWayBillSettings();
  const configured = settings.data?.configured === true;
  const reg = useQuery({ enabled: configured, queryKey: ['ewaybill', orgId, 'register', from, to], queryFn: () => api<EWayBillRegister>(`/v1/orgs/${orgId}/e-way-bills/documents?from=${from}&to=${to}`) });
  if (!org) return null;
  const go = (m: string) => router.replace(`/orgs/${orgId}/tax/e-way-bills?month=${m}`);
  const r = reg.data;

  return (
    <>
      <PageHeader
        title="E-way bills"
        description="Invoices with goods, whether each needs an e-way bill, and the e-way bills recorded for them. Prepare and record an e-way bill on the invoice. Talk2Tax does not connect to the e-way bill portal."
        actions={<Link href={`/orgs/${orgId}/settings/e-way-bills`}><Button variant="secondary">E-way bill settings</Button></Link>}
      />
      {settings.data && !configured ? (
        <EmptyState title="E-way bills are not set up" action={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/e-way-bills`}>Set up e-way bills</Link>}>
          Add the dispatch address and the value threshold first.
        </EmptyState>
      ) : null}
      {reg.error ? <Alert title="Could not load e-way bills">{(reg.error as Error).message}</Alert> : null}
      {r ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Needed, not recorded" value={String(r.summary.needed)} tone={r.summary.needed ? 'warning' : 'neutral'} sub={`Goods over ₹${Number(r.threshold).toLocaleString('en-IN')}`} />
            <Stat label="Need details" value={String(r.summary.needsData)} tone={r.summary.needsData ? 'warning' : 'neutral'} sub="Missing address, city or PIN code" />
            <Stat label="Recorded" value={String(r.summary.generated)} tone="positive" sub={`${r.summary.partAOnly} without a vehicle · ${r.summary.expiringSoon} expiring within 12 hours`} />
            <Stat label="Too old for the portal" value={String(r.summary.tooOld)} tone={r.summary.tooOld ? 'negative' : 'neutral'} sub={`${r.summary.optional} optional · ${r.summary.notApplicable} not applicable`} />
          </div>
          <div className="mt-6 flex items-center gap-2">
            <Button variant="ghost" aria-label="Previous month" onClick={() => go(monthStart(from, -1).slice(0, 7))}>←</Button>
            <span className="min-w-36 text-center text-sm font-medium">{monthName(from)}</span>
            <Button variant="ghost" aria-label="Next month" onClick={() => go(monthStart(from, 1).slice(0, 7))}>→</Button>
          </div>
          <Card className="mt-4">
            {r.rows.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Invoice</Th>
                      <Th>Date</Th>
                      <Th>Customer</Th>
                      <Th numeric>Goods value</Th>
                      <Th>E-way bill</Th>
                      <Th>Details</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((x) => {
                      const s = EWB_STATE[x.state];
                      return (
                        <tr key={x.documentId} className="border-t border-line">
                          <Td><Link className="whitespace-nowrap text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${x.documentId}`}>Invoice {x.number}</Link></Td>
                          <Td className="whitespace-nowrap">{date(x.issueDate)}</Td>
                          <Td>
                            {x.contact.name}
                            <p className="num text-xs text-fg-muted">{x.buyerGstin ?? 'Unregistered'}</p>
                          </Td>
                          <Td numeric><Money value={x.consignmentValue} currency="INR" /></Td>
                          <Td><Badge tone={s.tone} className="whitespace-nowrap">{s.label}</Badge></Td>
                          <Td className="max-w-md text-sm text-fg-muted"><Details x={x} /></Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            ) : (
              <EmptyState title={`No invoices in ${monthName(from)}`}>Try another month.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
