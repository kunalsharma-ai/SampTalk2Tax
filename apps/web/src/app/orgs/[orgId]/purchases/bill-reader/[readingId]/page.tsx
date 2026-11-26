'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DocumentForm } from '@/components/ledger/document-form';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { type BillReading, type FieldSource, isBeingRead, SOURCE_LABEL } from '@/lib/bill-reader';
import { date } from '@/lib/format';
import { PURCHASES } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import { can, type FinancialDocument } from '@/lib/types';

function Source({ s }: { s: FieldSource }) {
  return <Badge tone={s === 'FOUND' ? 'positive' : s === 'GUESSED' ? 'warning' : 'negative'}>{SOURCE_LABEL[s]}</Badge>;
}

/** One bill read by the bill reader (AP-025): what was found, the checks, and the bill form to review it in before saving. */
export default function BillReadingPage() {
  const { org, orgId } = useOrg();
  const { readingId } = useParams<{ readingId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/purchases/bill-reader/${readingId}`;
  const q = useQuery({
    queryKey: ['bill-reading', orgId, readingId],
    queryFn: () => api<BillReading>(base),
    enabled: !!org,
    // A PDF is read in the background (PERF-013): look again until it is read or failed.
    refetchInterval: (query) => (query.state.data && isBeingRead(query.state.data.status) ? 1000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bill-reading', orgId, readingId] });
    void qc.invalidateQueries({ queryKey: ['bill-readings', orgId] });
  };
  const discard = useMutation({ mutationFn: () => api<BillReading>(`${base}/discard`, { method: 'POST', body: {} }), onSuccess: refresh });
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'purchases.manage');
  const r = d?.reading;
  const cur = r?.currency.value ?? org.functionalCurrency;
  const fields: [string, string | null, FieldSource][] = r
    ? [
        ['Supplier', r.supplier.name ? `${r.supplier.name}${r.supplier.contactId ? '' : ' (not one of your vendors)'}` : null, r.supplier.source],
        ["Supplier's GSTIN", r.supplier.taxId, r.supplier.taxId ? 'FOUND' : 'MISSING'],
        ['Bill number', r.invoiceNumber.value, r.invoiceNumber.source],
        ['Bill date', r.issueDate.value ? date(r.issueDate.value) : null, r.issueDate.source],
        ['Due date', r.dueDate.value ? date(r.dueDate.value) : null, r.dueDate.source],
        ['Currency', r.currency.value, r.currency.source],
        ['Tax rate', r.taxPercent.value ? `${r.taxPercent.value}%` : null, r.taxPercent.source],
      ]
    : [];
  return (
    <>
      <PageHeader
        title={d ? `${d.number} · ${r?.supplier.name ?? 'Bill'}${r?.invoiceNumber.value ? ` ${r.invoiceNumber.value}` : ''}` : 'Bill reading'}
        description={d ? `${d.source === 'PDF' ? `Read from ${d.fileName}${d.pages ? ` (${d.pages} page${d.pages === 1 ? '' : 's'})` : ''}` : 'Read from pasted text'} by ${d.createdBy}. Check every field against the bill: the reader only finds what is printed on it.` : undefined}
        actions={
          <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/bill-reader`}>
            All bills read
          </Link>
        }
      />
      <ErrorAlert title="Could not load the reading" error={q.error ?? discard.error} />
      {d && isBeingRead(d.status) ? (
        <Alert tone="neutral" title="Reading the bill">
          The PDF is being read. This page updates by itself when it is done, usually within seconds; you can leave it and come back.
        </Alert>
      ) : null}
      {d && d.status === 'FAILED' ? (
        <Alert tone="negative" title="The bill could not be read">
          {d.failure} Nothing was saved.{' '}
          <Link className="underline" href={`/orgs/${orgId}/purchases/bill-reader`}>
            Read another bill
          </Link>
        </Alert>
      ) : null}
      {d && r ? (
        <>
          {r.checks.length ? (
            <Alert tone="warning" title="Check before saving">
              <ul className="list-disc pl-5" aria-label="Checks">
                {r.checks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="my-6 grid gap-6 lg:grid-cols-2">
            <Card role="region" aria-label="What the reader found">
              <CardHeader title="What the reader found" description="Each field says whether it was printed on the bill, worked out from it (such as a due date from payment terms), or not found." />
              <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 px-5 pb-5 text-sm">
                {fields.map(([k, v, s]) => (
                  <div key={k} className="contents">
                    <dt className="text-fg-muted">{k}</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <span>{v ?? '—'}</span>
                      <Source s={s} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
            <Card role="region" aria-label="Amounts on the bill">
              <CardHeader title="Amounts on the bill" description={r.linesFrom === 'TABLE' ? 'Items from the table on the bill, then its totals.' : r.linesFrom === 'TOTAL_ONLY' ? 'No table of items was found, so one line carries the amount before tax.' : 'No amounts were found.'} />
              <Table aria-label="Items read">
                <thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th numeric>Qty</Th>
                    <Th numeric>Rate</Th>
                    <Th numeric>Amount</Th>
                  </Tr>
                </thead>
                <tbody>
                  {r.lines.map((l, i) => (
                    <Tr key={i}>
                      <Td>
                        {l.description}
                        {l.hsnCode ? <span className="block text-xs text-fg-muted">HSN/SAC {l.hsnCode}</span> : null}
                      </Td>
                      <Td numeric>{l.quantity}</Td>
                      <Td numeric>
                        <Money value={l.unitPrice} currency={cur} />
                      </Td>
                      <Td numeric>
                        <Money value={l.amount} currency={cur} />
                      </Td>
                    </Tr>
                  ))}
                  {(
                    [
                      ['Subtotal', r.subtotal],
                      ...r.taxes.map((t) => [`${t.label}${t.rate ? ` @ ${t.rate}%` : ''}`, t.amount] as [string, string]),
                      ['Rounding', r.rounding],
                      ['Total', r.total],
                    ] as [string, string | null][]
                  )
                    .filter(([, v]) => v !== null)
                    .map(([k, v]) => (
                      <Tr key={k}>
                        <Td colSpan={3} className={k === 'Total' ? 'font-semibold' : 'text-fg-muted'}>
                          {k}
                        </Td>
                        <Td numeric className={k === 'Total' ? 'font-semibold' : ''}>
                          <Money value={v!} currency={cur} />
                        </Td>
                      </Tr>
                    ))}
                </tbody>
              </Table>
            </Card>
          </div>
          <details className="mb-6 text-sm">
            <summary className="cursor-pointer text-fg-muted">Show the text read from the bill</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-[var(--t2t-radius-md)] border border-line bg-surface p-3 text-xs" data-testid="read-text">
              {d.text}
            </pre>
          </details>
          {d.status === 'SAVED' && d.bill ? (
            <Alert tone="positive" title="Saved as a bill">
              Saved by {d.decidedBy} as{' '}
              <Link className="underline" href={`/orgs/${orgId}/purchases/bills/${d.bill.id}`}>
                {d.bill.number ?? 'a draft bill'}
              </Link>
              {d.attachmentId ? ', with the PDF attached' : ''}.
            </Alert>
          ) : d.status === 'DISCARDED' ? (
            <Alert tone="neutral" title="Discarded">Discarded by {d.decidedBy}. Nothing was saved to the books.</Alert>
          ) : manage ? (
            <section aria-label="Review and save">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Review and save the bill</h2>
                <Button variant="ghost" loading={discard.isPending} onClick={() => discard.mutate()}>
                  Discard this reading
                </Button>
              </div>
              <p className="mb-4 text-sm text-fg-muted">The bill form is filled in from the bill, with accounts suggested from the vendor&apos;s earlier bills. Correct anything that is wrong, then save it as a draft or post it. {d.source === 'PDF' ? 'The PDF is attached to the bill when it is saved.' : ''}</p>
              <DocumentForm
                l={PURCHASES}
                kind="BILL"
                prefill={{
                  contactId: r.supplier.contactId,
                  issueDate: r.issueDate.value,
                  dueDate: r.dueDate.value,
                  reference: r.invoiceNumber.value,
                  currency: r.currency.value,
                  lines: r.lines.map((l, i) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, hsnCode: l.hsnCode, accountId: r.suggestions[i]?.accountId ?? null, taxRateId: r.suggestions[i]?.taxRateId ?? null })),
                }}
                afterSave={async (bill: FinancialDocument) => {
                  await api(`${base}/link`, { method: 'POST', body: { documentId: bill.id } });
                  refresh();
                }}
              />
            </section>
          ) : (
            <Alert tone="neutral" title="Waiting to be reviewed">Someone who manages purchases reviews this reading and saves it as a bill.</Alert>
          )}
        </>
      ) : null}
    </>
  );
}
