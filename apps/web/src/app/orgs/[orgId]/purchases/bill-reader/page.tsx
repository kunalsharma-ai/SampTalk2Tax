'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, uploadFile } from '@/lib/api';
import { type BillReading, type BillReadingRow, isBeingRead } from '@/lib/bill-reader';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const STATUS = {
  QUEUED: <Badge>Reading…</Badge>,
  READING: <Badge>Reading…</Badge>,
  READ: <Badge tone="warning">To review</Badge>,
  FAILED: <Badge tone="negative">Could not be read</Badge>,
  SAVED: <Badge tone="positive">Saved as a bill</Badge>,
  DISCARDED: <Badge>Discarded</Badge>,
} as const;

/** Purchases → Bill reader (AP-025): read a supplier's bill from its PDF or text, then review it before it becomes a bill. */
export default function BillReaderPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const q = useQuery({
    queryKey: ['bill-readings', orgId],
    queryFn: () => api<BillReadingRow[]>(`/v1/orgs/${orgId}/purchases/bill-reader`),
    enabled: !!org,
    // PDFs are read in the background: look again while any is still being read.
    refetchInterval: (query) => (query.state.data?.some((r) => isBeingRead(r.status)) ? 1500 : false),
  });
  const done = (r: BillReading) => {
    void qc.invalidateQueries({ queryKey: ['bill-readings', orgId] });
    router.push(`/orgs/${orgId}/purchases/bill-reader/${r.id}`);
  };
  const readFile = useMutation({ mutationFn: (f: File) => uploadFile<BillReading>(`/v1/orgs/${orgId}/purchases/bill-reader/file?fileName=${encodeURIComponent(f.name)}`, f), onSuccess: done });
  const readText = useMutation({ mutationFn: () => api<BillReading>(`/v1/orgs/${orgId}/purchases/bill-reader/text`, { method: 'POST', body: { text } }), onSuccess: done });
  if (!org) return null;
  const manage = can(org.role, 'purchases.manage');
  return (
    <>
      <PageHeader
        title="Bill reader"
        description="Read a supplier's bill from the PDF they sent, or from its text, instead of typing it in. The reader finds the supplier, bill number, dates, items, taxes and total, and says where the bill does not add up. You check everything in the bill form before it is saved; nothing reaches the books until you do."
      />
      <ErrorAlert title="Could not read the bill" error={readFile.error ?? readText.error} />
      {manage ? (
        <Card role="region" aria-label="Read a bill" className="mb-6">
          <CardHeader title="Read a bill" description="A PDF made by the supplier's billing software reads best. A PDF is read in the background, usually within seconds, and you can keep working meanwhile. Scans and photos have no text to read: paste the text instead, or enter the bill by hand." />
          <div className="grid gap-6 px-5 pb-5 md:grid-cols-2">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (file) readFile.mutate(file);
              }}
            >
              <Field label="The bill as a PDF (up to 5 MB)">{(p) => <input {...p} type="file" accept="application/pdf,.pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
              <div>
                <Button type="submit" disabled={!file} loading={readFile.isPending}>
                  Read the PDF
                </Button>
              </div>
            </form>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                readText.mutate();
              }}
            >
              <Field label="Or paste the text of the bill">{(p) => <Textarea {...p} rows={6} maxLength={200000} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Supplier name\nInvoice No: …\nInvoice Date: …\nDescription  Qty  Rate  Amount\n…\nGrand Total  …'} />}</Field>
              <div>
                <Button type="submit" variant="secondary" disabled={!text.trim()} loading={readText.isPending}>
                  Read the text
                </Button>
              </div>
            </form>
          </div>
        </Card>
      ) : null}
      <ErrorAlert title="Could not load the bills read" error={q.error} />
      <Card role="region" aria-label="Bills read">
        <CardHeader title="Bills read" description="The latest 50, newest first. Open one to review it and save it as a bill." />
        {q.data?.length ? (
          <Table aria-label="Bills read">
            <thead>
              <Tr>
                <Th>Reading</Th>
                <Th>Supplier</Th>
                <Th>Bill number</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
                <Th>Bill</Th>
              </Tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <Link className="underline" href={`/orgs/${orgId}/purchases/bill-reader/${r.id}`}>
                      {r.number}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {r.source === 'PDF' ? r.fileName : 'Pasted text'} · {date(r.createdAt.slice(0, 10))}
                    </span>
                  </Td>
                  <Td>{r.supplier ?? <span className="text-fg-muted">Not found</span>}</Td>
                  <Td>{r.invoiceNumber ?? <span className="text-fg-muted">Not found</span>}</Td>
                  <Td numeric>{r.total ? <Money value={r.total} currency={r.currency ?? org.functionalCurrency} /> : '—'}</Td>
                  <Td>
                    {STATUS[r.status]}
                    {r.status === 'READ' && r.checks ? <span className="block text-xs text-warning">{r.checks} to check</span> : null}
                    {r.status === 'FAILED' && r.failure ? <span className="block max-w-xs text-xs text-fg-muted">{r.failure}</span> : null}
                  </Td>
                  <Td>
                    {r.bill ? (
                      <Link className="underline" href={`/orgs/${orgId}/purchases/bills/${r.bill.id}`}>
                        {r.bill.number ?? 'Draft bill'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? (
          <EmptyState title="No bills read yet">Read a supplier&apos;s PDF bill above to start.</EmptyState>
        ) : null}
      </Card>
    </>
  );
}
