'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Money } from '@/components/money';
import { DateInput } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { BUCKET_LABELS, type LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import type { Ageing } from '@/lib/types';

const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;

export function AgeingReport({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const [asOf, setAsOf] = useState(today());
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['ageing', orgId, l.api, asOf], queryFn: () => api<Ageing>(`/v1/orgs/${orgId}/${l.api}/ageing?asOf=${asOf}`) });
  if (!org) return null;
  const a = q.data;
  const c = org.functionalCurrency;
  const rec = a?.reconciliation;
  const ties = rec?.difference === '0.00';
  return (
    <>
      <PageHeader
        title={l.ageingTitle}
        description={`Open ${l.charge.plural.toLowerCase()} by days past due, less unapplied credits and ${l.payment.plural.toLowerCase()}.`}
        actions={<><DateInput label="As of" value={asOf} onChange={setAsOf} /><ExportButtons orgId={orgId} report={l.api === 'sales' ? 'receivables-ageing' : 'payables-ageing'} params={{ asOf }} /></>}
      />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {a ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {BUCKETS.map((b, i) => (
              <Stat key={b} label={BUCKET_LABELS[b]} value={<Money value={a.totals[b]} currency={c} />} tone={i === 0 ? 'accent' : i >= 3 ? 'negative' : 'warning'} />
            ))}
            <Stat label="Net balance" value={<Money value={a.totals.balance} currency={c} />} sub={a.totals.unapplied !== '0.00' ? <>after unapplied <Money value={a.totals.unapplied} currency={c} /></> : undefined} tone="violet" />
          </div>
          <div className="mt-4">
            {rec?.controlAccountBalance ? (
              <Alert tone={ties ? 'positive' : 'negative'} title={ties ? 'Ties to the general ledger' : 'Does not tie to the general ledger'}>
                {l.ledger === 'SALES' ? 'Receivables' : 'Payables'} control account balance <Money value={rec.controlAccountBalance} currency={c} />, ageing total <Money value={rec.subledgerBalance} currency={c} />
                {ties ? '.' : <>, difference <Money value={rec.difference} currency={c} />.</>}
              </Alert>
            ) : (
              <Alert tone="warning" title="No control account">This organisation has no {l.ledger === 'SALES' ? 'receivables' : 'payables'} control account set.</Alert>
            )}
          </div>
          <Card className="mt-6">
            <CardHeader title={`By ${l.contact.toLowerCase()}`} description={`As of ${date(a.asOf)}. Select a row to see the open items.`} />
            {a.rows.length === 0 ? (
              <p className="px-5 py-4 text-sm text-fg-muted">Nothing open as of this date.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{l.contact}</Th>
                    {BUCKETS.map((b) => <Th key={b} numeric>{BUCKET_LABELS[b]}</Th>)}
                    <Th numeric>Unapplied</Th>
                    <Th numeric>Balance</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.rows.map((r) => (
                    <Fragment key={r.contactId}>
                      <Tr className="cursor-pointer" onClick={() => setExpanded(expanded === r.contactId ? null : r.contactId)}>
                        <Td>
                          <button className="mr-2 text-fg-muted" aria-expanded={expanded === r.contactId} aria-label={`Show items for ${r.contactName}`}>{expanded === r.contactId ? '▾' : '▸'}</button>
                          <Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.contactsPath}/${r.contactId}`} onClick={(e) => e.stopPropagation()}>{r.contactName}</Link>
                        </Td>
                        {BUCKETS.map((b) => <Td key={b} numeric>{r[b] !== '0.00' ? <Money value={r[b]} currency={c} /> : <span className="text-fg-faint">—</span>}</Td>)}
                        <Td numeric>{r.unapplied !== '0.00' ? <Money value={r.unapplied} currency={c} /> : <span className="text-fg-faint">—</span>}</Td>
                        <Td numeric className="font-semibold"><Money value={r.balance} currency={c} signed /></Td>
                      </Tr>
                      {expanded === r.contactId
                        ? r.items.map((i) => (
                            <tr key={i.id} className="bg-surface-hover/40 text-xs">
                              <Td className="pl-10">
                                <Link className="text-accent hover:underline" href={`/orgs/${orgId}/${i.type === 'payment' ? l.paymentsPath : l.docsPath}/${i.id}`}>{i.number}</Link>
                                <span className="text-fg-muted"> · {date(i.date)}{i.dueDate ? ` · due ${date(i.dueDate)}` : ''}{i.daysOverdue ? ` · ${i.daysOverdue} days overdue` : ''}</span>
                                {i.foreignOpen ? <span className="block text-fg-muted">{money(i.foreignOpen, i.currency)} open, carried at {i.rate}</span> : null}
                              </Td>
                              {BUCKETS.map((b) => <Td key={b} numeric>{i.bucket === b ? <Money value={i.open} currency={c} /> : ''}</Td>)}
                              <Td numeric>{i.type !== 'charge' ? <Money value={i.open} currency={c} /> : ''}</Td>
                              <Td />
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <Td className="font-semibold">Total</Td>
                    {BUCKETS.map((b) => <Td key={b} numeric className="font-semibold"><Money value={a.totals[b]} currency={c} /></Td>)}
                    <Td numeric className="font-semibold"><Money value={a.totals.unapplied} currency={c} /></Td>
                    <Td numeric className="font-semibold"><Money value={a.totals.balance} currency={c} /></Td>
                  </tr>
                </tfoot>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
