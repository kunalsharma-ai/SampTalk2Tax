'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { TaxDocumentDetail } from '@/lib/tax-documents';
import { can } from '@/lib/types';

const LEVEL = { ERROR: 'negative', WARNING: 'warning', OK: 'positive' } as const;
const LEVEL_LABEL = { ERROR: 'Problem', WARNING: 'Check', OK: 'Fine' } as const;

/** Tax → Tax documents → one reading (TAX-043). */
export default function TaxDocumentPage() {
  const { org, orgId } = useOrg();
  const { readingId } = useParams<{ readingId: string }>();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const url = `/v1/orgs/${orgId}/tax/document-readings/${readingId}`;
  const q = useQuery({ queryKey: ['tax-document', orgId, readingId], queryFn: () => api<TaxDocumentDetail>(url), enabled: !!org });
  const review = useMutation({
    mutationFn: () => api<TaxDocumentDetail>(`${url}/review`, { method: 'POST', body: { note } }),
    onSuccess: (d) => {
      qc.setQueryData(['tax-document', orgId, readingId], d);
      return qc.invalidateQueries({ queryKey: ['tax-documents', orgId] });
    },
  });
  if (!org) return null;
  const d = q.data;
  const r = d?.reading;
  const currency = r?.kind === 'FORM_1099' ? 'USD' : 'INR';
  const m = (x: string | null) => (x === null ? '—' : money(x, currency));
  return (
    <>
      <PageHeader
        title={d ? `${d.number}: ${r!.title}` : 'Tax document'}
        description={d ? `${d.source === 'PDF' ? d.fileName : 'Pasted text'}, read by ${d.createdBy} on ${date(d.createdAt.slice(0, 10))}.` : undefined}
      />
      <p className="mb-4 text-sm">
        <Link className="underline" href={`/orgs/${orgId}/tax/documents`}>
          All tax documents
        </Link>
      </p>
      <ErrorAlert title="Could not load the document" error={q.error} />
      {d && r ? (
        <>
          <Card role="region" aria-label="What this document is">
            <CardHeader title="What this document is" description={`Explanations written from the published forms, checked on ${date(r.checkedOn)}. They need review by a tax adviser.`} />
            <div className="space-y-3 px-5 pb-5 text-sm">
              <p>{r.what}</p>
              <p>
                <span className="font-medium">What to do: </span>
                {r.todo}
              </p>
            </div>
          </Card>

          <Card className="mt-6" role="region" aria-label="Checks on the document">
            <CardHeader title="Checks on the document" description="The document's figures checked against each other and against your PAN, GSTIN and books." />
            {r.checks.length ? (
              <ul className="space-y-2 px-5 pb-5">
                {r.checks.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Badge tone={LEVEL[c.level]}>{LEVEL_LABEL[c.level]}</Badge>
                    <span>{c.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing to check">No check applies to what was found.</EmptyState>
            )}
          </Card>

          <Card className="mt-6" role="region" aria-label="What the document says">
            <CardHeader title="What the document says" description="Each value with the line it was read from. A field that is not listed was not found." />
            {r.fields.length ? (
              <Table aria-label="What the document says">
                <thead>
                  <Tr>
                    <Th>Field</Th>
                    <Th>Value</Th>
                    <Th>Read from</Th>
                  </Tr>
                </thead>
                <tbody>
                  {r.fields.map((f) => (
                    <Tr key={f.key}>
                      <Td>{f.label}</Td>
                      <Td className="font-medium">{f.value}</Td>
                      <Td className="text-xs text-fg-muted">{f.line}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No fields found">The text did not have the labels of a known tax document.</EmptyState>
            )}
          </Card>

          {r.kind === 'ANNUAL_TAX_STATEMENT' ? (
            <Card className="mt-6" role="region" aria-label="Tax deducted by each deductor">
              <CardHeader
                title="Tax deducted by each deductor"
                description={`Total paid ${m(r.totals.amountPaid)}, tax deducted ${m(r.totals.taxDeducted)}${r.booksTds !== null ? `, your TDS receivable account for ${r.year} ${m(r.booksTds)}` : '. Choose the TDS receivable account on the Advance tax page to compare it with your books'}.`}
              />
              {r.deductors.length ? (
                <Table aria-label="Tax deducted by each deductor">
                  <thead>
                    <Tr>
                      <Th>Deductor</Th>
                      <Th>TAN</Th>
                      <Th className="text-right">Paid or credited</Th>
                      <Th className="text-right">Tax deducted</Th>
                      <Th className="text-right">Tax deposited</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {r.deductors.map((x) => (
                      <Tr key={x.tan + x.line}>
                        <Td>{x.name}</Td>
                        <Td>{x.tan}</Td>
                        <Td className="text-right">{m(x.amountPaid)}</Td>
                        <Td className="text-right">{m(x.taxDeducted)}</Td>
                        <Td className="text-right">{m(x.taxDeposited)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No deductor rows found">Rows need a name, a TAN and the amounts on one line.</EmptyState>
              )}
            </Card>
          ) : null}

          <Card className="mt-6" role="region" aria-label="Review this document">
            <CardHeader title="Review this document" description="Mark the document reviewed once you have acted on it, for example booked the TDS or asked for a correction." />
            <div className="px-5 pb-5">
              {d.status === 'REVIEWED' ? (
                <Alert tone="positive" title={`Reviewed by ${d.reviewedBy} on ${date(d.reviewedAt!.slice(0, 10))}`}>
                  {d.reviewNote ?? 'No note.'}
                </Alert>
              ) : can(org.role, 'accounts.manage') ? (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    review.mutate();
                  }}
                >
                  <Field label="Note (optional)">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                  <div>
                    <Button type="submit" loading={review.isPending}>
                      Mark reviewed
                    </Button>
                  </div>
                  <ErrorAlert title="Could not mark it reviewed" error={review.error} />
                </form>
              ) : (
                <p className="text-sm text-fg-muted">Not reviewed yet.</p>
              )}
            </div>
          </Card>

          <details className="mt-6 text-sm">
            <summary className="cursor-pointer">The text that was read</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-line p-3 text-xs">{d.text}</pre>
          </details>
        </>
      ) : null}
    </>
  );
}
