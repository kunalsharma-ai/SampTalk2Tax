'use client';
import { useQuery } from '@tanstack/react-query';
import { GST_DISCREPANCY_LABEL, GST_RECON_ITEM_LABEL, type GstDiscrepancy, type GstReconItem, type GstSides } from '@talk2tax/tax-engine';
import { Alert, Badge, Card, CardHeader, EmptyState, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Reconciliation {
  period: string;
  gstin: string;
  from: string;
  to: string;
  returns: GstSides;
  ledger: GstSides;
  settled: GstSides;
  difference: GstSides;
  unexplained: GstSides;
  agrees: boolean;
  items: GstReconItem[];
  documentsChecked: number;
  discrepancies: GstDiscrepancy[];
  discrepancyCounts: { high: number; medium: number; low: number };
}
type Head = 'igst' | 'cgst' | 'sgst';
const HEADS: Head[] = ['igst', 'cgst', 'sgst'];
const ROWS: { side: 'output' | 'input'; head: Head; label: string }[] = [
  ...HEADS.map((head) => ({ side: 'output' as const, head, label: `Output ${head.toUpperCase()}` })),
  ...HEADS.map((head) => ({ side: 'input' as const, head, label: `Input ${head.toUpperCase()}` })),
];
const SEVERITY_TONE = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' } as const;
const lastMonth = () => {
  const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const monthLabel = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const nonZero = (s: GstSides) => ROWS.filter((r) => s[r.side][r.head] !== '0.00');

/** Tax → GST reconciliation (TAX-045, TAX-044): the month's GST accounts against its documents, and tax mistakes in its documents. */
export default function GstReconciliationPage() {
  const { org, orgId } = useOrg();
  const [period, setPeriod] = useState(lastMonth);
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const q = useQuery({ queryKey: ['gst-reconciliation', orgId, period], queryFn: () => api<Reconciliation>(`/v1/orgs/${orgId}/gst/reconciliation?period=${period}`), enabled: valid });
  if (!org) return null;
  const r = q.data;
  const docHref = (kind: string | null, id: string) => (kind === 'BILL' || kind === 'VENDOR_CREDIT' ? `/orgs/${orgId}/purchases/bills/${id}` : `/orgs/${orgId}/sales/invoices/${id}`);
  const effect = (s: GstSides) =>
    nonZero(s).map((x) => (
      <span key={`${x.side}${x.head}`} className="block">
        <span className="text-fg-muted">{x.label}</span> <Money value={s[x.side][x.head]} currency="INR" />
      </span>
    ));
  return (
    <>
      <PageHeader
        title="GST reconciliation"
        description="The month's GST accounts in the books against what its invoices, credit notes, bills and vendor credits say, the figures that go into GSTR-3B. Every difference is traced to the journal or document that made it, and the month's documents are checked for tax mistakes."
        actions={<div className="w-44"><Input type="month" aria-label="Month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} /></div>}
      />
      <ErrorAlert title="Could not reconcile GST" error={q.error} />
      {r ? (
        <>
          <div className="mb-4">
            {r.agrees ? (
              <Alert tone="positive" title={`The books agree with the documents for ${monthLabel(r.period)}`}>Every movement on the GST accounts comes from a document of the month{nonZero(r.settled).length ? ', apart from GST payments' : ''}.</Alert>
            ) : (
              <Alert tone="warning" title={`The books differ from the documents for ${monthLabel(r.period)}`}>{r.items.length === 1 ? '1 item explains' : `${r.items.length} items explain`} the difference. Correct the journal or document, or amend the return of the period it belongs to.</Alert>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <Card className="p-4"><p className="text-sm text-fg-muted">GSTIN</p><p className="num mt-1 text-lg font-semibold">{r.gstin}</p><p className="text-xs text-fg-muted">{date(r.from)} to {date(r.to)}</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Differences explained</p><p className={`mt-1 text-2xl font-semibold ${r.items.length ? 'text-warning' : ''}`}>{r.items.length}</p><p className="text-xs text-fg-muted">{nonZero(r.unexplained).length ? 'Some of the difference is unexplained' : 'Nothing left unexplained'}</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Tax mistakes found</p><p className={`mt-1 text-2xl font-semibold ${r.discrepancyCounts.high ? 'text-negative' : r.discrepancies.length ? 'text-warning' : ''}`}>{r.discrepancies.length}</p><p className="text-xs text-fg-muted">{r.discrepancyCounts.high} high, {r.discrepancyCounts.medium} medium, {r.discrepancyCounts.low} low</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Documents checked</p><p className="mt-1 text-2xl font-semibold">{r.documentsChecked}</p><p className="text-xs text-fg-muted">Posted in the month</p></Card>
          </div>
          <Card className="mt-6" role="region" aria-label="Books against documents">
            <CardHeader title="Books against documents" description="Movement on each GST account in the month. Output accounts carry tax on sales and reverse-charge tax; input accounts carry input tax credit. GST payments settle the accounts and are shown apart." />
            <Table aria-label="Books against documents">
              <thead><Tr><Th>Account</Th><Th numeric>Documents (GSTR-3B)</Th><Th numeric>Books</Th><Th numeric>Difference</Th><Th numeric>GST payments</Th></Tr></thead>
              <tbody>
                {ROWS.map((x) => {
                  const diff = r.difference[x.side][x.head];
                  return (
                    <Tr key={`${x.side}${x.head}`}>
                      <Td>{x.label}</Td>
                      <Td numeric><Money value={r.returns[x.side][x.head]} currency="INR" /></Td>
                      <Td numeric><Money value={r.ledger[x.side][x.head]} currency="INR" /></Td>
                      <Td numeric className={diff === '0.00' ? 'text-fg-muted' : 'font-semibold text-warning'}><Money value={diff} currency="INR" /></Td>
                      <Td numeric className="text-fg-muted"><Money value={r.settled[x.side][x.head]} currency="INR" /></Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
          <Card className="mt-6" role="region" aria-label="What makes the difference">
            <CardHeader title="What makes the difference" description="Each journal or document that moved a GST account differently from the month's documents, largest first. Together they add up to the difference." />
            {r.items.length ? (
              <Table aria-label="What makes the difference">
                <thead><Tr><Th>Date</Th><Th>Kind</Th><Th>What happened</Th><Th numeric>Effect on the books</Th></Tr></thead>
                <tbody>
                  {r.items.map((i, n) => (
                    <Tr key={`${i.entryId ?? i.documentId}-${n}`}>
                      <Td className="align-top">{date(i.date)}</Td>
                      <Td className="align-top"><Badge tone={i.kind === 'OTHER_ENTRY' || i.kind === 'POSTING_DIFFERS' ? 'warning' : 'neutral'}>{GST_RECON_ITEM_LABEL[i.kind]}</Badge></Td>
                      <Td className="align-top">
                        <span className="block max-w-xl">{i.message}</span>
                        <span className="mt-1 flex gap-3 text-xs">
                          {i.documentId ? <Link className="underline" href={docHref(i.documentKind, i.documentId)}>Open {i.documentNumber}</Link> : null}
                          {i.entryId ? <Link className="underline" href={`/orgs/${orgId}/journals/${i.entryId}`}>Open journal</Link> : null}
                        </span>
                      </Td>
                      <Td numeric className="align-top text-sm">{effect(i.effect)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing to explain">The GST accounts moved only by the month&apos;s documents{nonZero(r.settled).length ? ' and GST payments' : ''}.</EmptyState>
            )}
          </Card>
          <Card className="mt-6" role="region" aria-label="Tax mistakes in documents">
            <CardHeader title="Tax mistakes in documents" description="The month's posted documents checked for tax in the wrong heads, tax that is not the rate on the value, tax on exempt lines, GSTIN problems, credit claimed without the supplier's GSTIN, missing HSN codes and one HSN sold at different rates. Worst first." />
            {r.discrepancies.length ? (
              <Table aria-label="Tax mistakes in documents">
                <thead><Tr><Th>Severity</Th><Th>Check</Th><Th>Document</Th><Th>What is wrong</Th><Th numeric>Tax</Th></Tr></thead>
                <tbody>
                  {r.discrepancies.map((d, n) => (
                    <Tr key={`${d.kind}-${d.documentId ?? ''}-${d.lineNo ?? n}`}>
                      <Td className="align-top"><Badge tone={SEVERITY_TONE[d.severity]}>{d.severity === 'HIGH' ? 'High' : d.severity === 'MEDIUM' ? 'Medium' : 'Low'}</Badge></Td>
                      <Td className="align-top">{GST_DISCREPANCY_LABEL[d.kind]}</Td>
                      <Td className="align-top">{d.documentId ? <Link className="underline" href={docHref(d.documentKind, d.documentId)}>{d.documentNumber}</Link> : <span className="text-fg-faint">Several</span>}{d.date ? <span className="block text-xs text-fg-muted">{date(d.date)}</span> : null}</Td>
                      <Td className="align-top"><span className="block max-w-xl">{d.message}</span></Td>
                      <Td numeric className="align-top">{d.amount ? <Money value={d.amount} currency="INR" /> : '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No tax mistakes found">{r.documentsChecked} posted document{r.documentsChecked === 1 ? '' : 's'} checked.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
