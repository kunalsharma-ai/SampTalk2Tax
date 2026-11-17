'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, EmptyState, Stat, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { downloadJson, EINVOICE_STATE, istTime } from '@/components/e-invoice';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useEInvoiceSettings, useOrg } from '@/lib/org';
import type { EInvoiceRegister } from '@/lib/types';

const monthStart = (iso: string, shift = 0) => {
  const d = new Date(Date.parse(`${iso.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() + shift);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (iso: string) => new Date(Date.parse(monthStart(iso, 1)) - 86_400_000).toISOString().slice(0, 10);
const monthName = (iso: string) => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function EInvoicesPage() {
  return (
    <Suspense>
      <EInvoices />
    </Suspense>
  );
}

function EInvoices() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const month = params.get('month') ?? today().slice(0, 7);
  const from = `${month}-01`;
  const to = monthEnd(from);
  const settings = useEInvoiceSettings();
  const configured = settings.data?.configured === true;
  const reg = useQuery({ enabled: configured, queryKey: ['einvoice', orgId, 'register', from, to], queryFn: () => api<EInvoiceRegister>(`/v1/orgs/${orgId}/e-invoicing/documents?from=${from}&to=${to}`) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<{ number: string | null; reason: string }[]>([]);
  const bulk = useMutation({
    mutationFn: (ids: string[]) => api<{ payloads: unknown[]; skipped: { number: string | null; reason: string }[] }>(`/v1/orgs/${orgId}/e-invoicing/bulk-json`, { method: 'POST', body: { documentIds: ids } }),
    onSuccess: (r) => {
      if (r.payloads.length) downloadJson(`einvoices-${month}.json`, r.payloads);
      setSkipped(r.skipped);
    },
  });
  if (!org) return null;
  const go = (m: string) => {
    setPicked(new Set());
    setSkipped([]);
    router.replace(`/orgs/${orgId}/tax/e-invoices?month=${m}`);
  };
  const r = reg.data;
  const ready = (r?.rows ?? []).filter((x) => x.state === 'READY');
  const allPicked = ready.length > 0 && ready.every((x) => picked.has(x.documentId));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <>
      <PageHeader
        title="E-invoices"
        description="B2B invoices and credit notes with their e-invoice state. Download the JSON, upload it to the IRP, then import the IRP's response on each document. Talk2Tax does not connect to the IRP."
        actions={<Link href={`/orgs/${orgId}/settings/e-invoicing`}><Button variant="secondary">E-invoicing settings</Button></Link>}
      />
      {settings.data && !configured ? (
        <EmptyState title="E-invoicing is not set up" action={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/e-invoicing`}>Set up e-invoicing</Link>}>
          Add the date e-invoicing applies from and the seller address first.
        </EmptyState>
      ) : null}
      {reg.error ? <Alert title="Could not load e-invoices">{(reg.error as Error).message}</Alert> : null}
      {r ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ready for IRP" value={String(r.summary.ready)} tone={r.summary.ready ? 'accent' : 'neutral'} sub="JSON can be downloaded" />
            <Stat label="Need details" value={String(r.summary.needsData)} tone={r.summary.needsData ? 'warning' : 'neutral'} sub="Missing PIN, HSN or address" />
            <Stat label="Past 30 days" value={String(r.summary.tooLate)} tone={r.summary.tooLate ? 'negative' : 'neutral'} sub={r.aatoTenCroreOrMore ? 'The IRP will refuse these' : '30-day limit does not apply'} />
            <Stat label="IRN generated" value={String(r.summary.generated)} tone="positive" sub={`${r.summary.cancelled} cancelled · ${r.summary.notRequired} not required or not supported`} />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" aria-label="Previous month" onClick={() => go(monthStart(from, -1).slice(0, 7))}>←</Button>
              <span className="min-w-36 text-center text-sm font-medium">{monthName(from)}</span>
              <Button variant="ghost" aria-label="Next month" onClick={() => go(monthStart(from, 1).slice(0, 7))}>→</Button>
            </div>
            <Button disabled={!picked.size} loading={bulk.isPending} onClick={() => bulk.mutate([...picked])}>Download JSON ({picked.size} selected)</Button>
          </div>
          {bulk.error ? <div className="mt-3"><Alert title="Not downloaded">{bulk.error instanceof ApiError ? bulk.error.message : 'Try again.'}</Alert></div> : null}
          {skipped.length ? <div className="mt-3"><Alert tone="warning" title="Some documents were left out">{skipped.map((s) => `${s.number}: ${s.reason}`).join(' · ')}</Alert></div> : null}
          <Card className="mt-4">
            {r.rows.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-8"><input type="checkbox" aria-label="Select all ready documents" className="accent-[var(--t2t-accent)]" disabled={!ready.length} checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(ready.map((x) => x.documentId)))} /></Th>
                      <Th>Document</Th>
                      <Th>Date</Th>
                      <Th>Customer</Th>
                      <Th numeric>Total</Th>
                      <Th>E-invoice</Th>
                      <Th>Details</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((x) => {
                      const s = EINVOICE_STATE[x.state];
                      return (
                        <tr key={x.documentId} className="border-t border-line">
                          <Td>{x.state === 'READY' ? <input type="checkbox" aria-label={`Select ${x.number}`} className="accent-[var(--t2t-accent)]" checked={picked.has(x.documentId)} onChange={() => toggle(x.documentId)} /> : null}</Td>
                          <Td>
                            <Link className="whitespace-nowrap text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${x.documentId}`}>{x.kind === 'CREDIT_NOTE' ? 'Credit note' : x.kind === 'DEBIT_NOTE' ? 'Debit note' : 'Invoice'} {x.number}</Link>
                          </Td>
                          <Td className="whitespace-nowrap">{date(x.issueDate)}</Td>
                          <Td>
                            {x.contact.name}
                            {x.buyerGstin ? <p className="num text-xs text-fg-muted">{x.buyerGstin}</p> : null}
                          </Td>
                          <Td numeric><Money value={x.total} currency="INR" /></Td>
                          <Td><Badge tone={s.tone} className="whitespace-nowrap">{s.label}</Badge></Td>
                          <Td className="max-w-md text-sm text-fg-muted">
                            {x.state === 'GENERATED' && x.eInvoice ? <>Ack. <span className="num">{x.eInvoice.ackNo}</span>, {istTime(x.eInvoice.ackDate)}{x.eInvoice.signatureVerified ? '' : ' · signature not verified'}</> : x.reason}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            ) : (
              <EmptyState title={`No invoices or credit notes in ${monthName(from)}`}>Try another month.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
