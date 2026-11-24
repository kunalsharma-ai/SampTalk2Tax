'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api, uploadFile } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { TaxDocumentDetail, TaxDocumentRow } from '@/lib/tax-documents';
import { can } from '@/lib/types';

/** Tax → Tax documents (TAX-043): read a TDS certificate, annual tax statement, GST challan or 1099 and see what it means. */
export default function TaxDocumentsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const base = `/v1/orgs/${orgId}/tax/document-readings`;
  const q = useQuery({ queryKey: ['tax-documents', orgId], queryFn: () => api<TaxDocumentRow[]>(base), enabled: !!org });
  const done = (r: TaxDocumentDetail) => {
    void qc.invalidateQueries({ queryKey: ['tax-documents', orgId] });
    router.push(`/orgs/${orgId}/tax/documents/${r.id}`);
  };
  const readFile = useMutation({ mutationFn: (f: File) => uploadFile<TaxDocumentDetail>(`${base}/file?fileName=${encodeURIComponent(f.name)}`, f), onSuccess: done });
  const readText = useMutation({ mutationFn: () => api<TaxDocumentDetail>(`${base}/text`, { method: 'POST', body: { text } }), onSuccess: done });
  if (!org) return null;
  const manage = can(org.role, 'accounts.manage');
  return (
    <>
      <PageHeader
        title="Tax documents"
        description="Read a tax document you received and see what it is, what it says and what to do with it: a TDS certificate (Form 16A), the annual tax statement (Form 26AS or AIS), a GST payment challan (PMT-06) or a US Form 1099. Each figure is shown with the line it was read from, and checked against your PAN, GSTIN and books. Nothing is guessed, and no AI model is used."
      />
      <ErrorAlert title="Could not read the document" error={readFile.error ?? readText.error} />
      {manage ? (
        <Card role="region" aria-label="Read a tax document" className="mb-6">
          <CardHeader title="Read a tax document" description="A PDF downloaded from the tax portal reads best. Scans and photos have no text to read: paste the text instead." />
          <div className="grid gap-6 px-5 pb-5 md:grid-cols-2">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (file) readFile.mutate(file);
              }}
            >
              <Field label="The document as a PDF (up to 5 MB)">
                {(p) => <input {...p} type="file" accept="application/pdf,.pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
              </Field>
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
              <Field label="Or paste the text of the document">{(p) => <Textarea {...p} rows={6} maxLength={200000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
              <div>
                <Button type="submit" variant="secondary" disabled={!text.trim()} loading={readText.isPending}>
                  Read the text
                </Button>
              </div>
            </form>
          </div>
        </Card>
      ) : null}
      <ErrorAlert title="Could not load the documents read" error={q.error} />
      <Card role="region" aria-label="Tax documents read">
        <CardHeader title="Tax documents read" description="The latest 50, newest first. Open one to see what it says and mark it reviewed once you have acted on it." />
        {q.data?.length ? (
          <Table aria-label="Tax documents read">
            <thead>
              <Tr>
                <Th>Reading</Th>
                <Th>Document</Th>
                <Th>Year</Th>
                <Th>Status</Th>
              </Tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <Link className="underline" href={`/orgs/${orgId}/tax/documents/${r.id}`}>
                      {r.number}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {r.source === 'PDF' ? r.fileName : 'Pasted text'} · {date(r.createdAt.slice(0, 10))}
                    </span>
                  </Td>
                  <Td>{r.title}</Td>
                  <Td>{r.year ?? '—'}</Td>
                  <Td>
                    {r.status === 'REVIEWED' ? <Badge tone="positive">Reviewed</Badge> : <Badge tone="warning">To review</Badge>}
                    {r.problems ? <span className="block text-xs text-warning">{r.problems} to check</span> : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No tax documents read yet">{manage ? 'Upload or paste one above.' : 'Someone who manages the accounts can read one.'}</EmptyState>
        )}
      </Card>
    </>
  );
}
