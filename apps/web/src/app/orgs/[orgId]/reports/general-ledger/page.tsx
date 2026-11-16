'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { type EntrySource, graphHref } from '@/lib/graph';
import { useAccounts, useOrg } from '@/lib/org';

interface Ledger {
  account: { code: string; name: string; type: string };
  openingBalance: string;
  closingBalance: string;
  rows: { journalId: string; entryNumber: number; date: string; memo: string | null; description: string | null; debit: string; credit: string; runningBalance: string; source: EntrySource | null }[];
}

function LedgerView() {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const params = useSearchParams();
  const router = useRouter();
  const accountId = params.get('accountId') ?? '';
  const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const [to, setTo] = useState(() => iso(params.get('to')) ?? today());
  const [from, setFrom] = useState(() => iso(params.get('from')) ?? fyStartFor(iso(params.get('to')) ?? today(), org?.fiscalYearStartMonth ?? 4));
  const q = useQuery({
    enabled: !!accountId,
    queryKey: ['ledger', orgId, accountId, from, to],
    queryFn: () => api<Ledger>(`/v1/orgs/${orgId}/reports/general-ledger?accountId=${accountId}&from=${from}&to=${to}`),
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="General ledger"
        description="Every posted line for one account, with a running balance and the record that created it."
        actions={
          <>
            <label className="sr-only" htmlFor="gl-acc">Account</label>
            <Select id="gl-acc" className="w-72" value={accountId} onChange={(e) => router.replace(`?accountId=${e.target.value}&from=${from}&to=${to}`)}>
              <option value="">Choose an account…</option>
              {(accounts.data ?? []).filter((a) => a.isPostable).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
            <ExportButtons orgId={orgId} report="general-ledger" params={{ accountId, from, to }} disabled={!accountId} />
          </>
        }
      />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      <Card>
        {!accountId ? (
          <EmptyState title="Choose an account">Pick an account above to see its ledger.</EmptyState>
        ) : q.data ? (
          <>
            <CardHeader title={`${q.data.account.code} · ${q.data.account.name}`} description={<>Opening <Money value={q.data.openingBalance} currency={c} signed /> · Closing <Money value={q.data.closingBalance} currency={c} signed /></>} />
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Journal</Th>
                  <Th>Source</Th>
                  <Th>Memo</Th>
                  <Th numeric>Debit</Th>
                  <Th numeric>Credit</Th>
                  <Th numeric>Balance</Th>
                </tr>
              </thead>
              <tbody>
                <tr><Td colSpan={6} className="text-fg-muted">Opening balance</Td><Td numeric><Money value={q.data.openingBalance} currency={c} signed /></Td></tr>
                {q.data.rows.map((r, i) => (
                  <Tr key={`${r.journalId}-${i}`}>
                    <Td className="whitespace-nowrap">{date(r.date)}</Td>
                    <Td className="num"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${r.journalId}`}>JE-{String(r.entryNumber).padStart(6, '0')}</Link></Td>
                    <Td className="whitespace-nowrap text-sm">
                      {r.source ? (
                        <>
                          <span className="text-xs text-fg-muted">{r.source.role} </span>
                          {r.source.path ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${r.source.path}`}>{r.source.label}</Link> : r.source.label}
                        </>
                      ) : (
                        <span className="text-xs text-fg-muted">Manual journal</span>
                      )}
                      <Link className="ml-2 text-xs text-fg-muted hover:text-accent" href={graphHref(orgId, ['DOCUMENT', 'PAYMENT', 'LOAN', 'ASSET'].includes(r.source?.type ?? '') ? { type: r.source!.type, id: r.source!.id } : { type: 'JOURNAL', id: r.journalId })} aria-label={`Connections of JE-${String(r.entryNumber).padStart(6, '0')}`}>Connections</Link>
                    </Td>
                    <Td className="max-w-[240px] truncate text-fg-muted">{r.description || r.memo}</Td>
                    <Td numeric>{r.debit !== '0.00' ? <Money value={r.debit} currency={c} /> : ''}</Td>
                    <Td numeric>{r.credit !== '0.00' ? <Money value={r.credit} currency={c} /> : ''}</Td>
                    <Td numeric><Money value={r.runningBalance} currency={c} signed /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </>
        ) : (
          <p className="p-5 text-sm text-fg-muted">Loading…</p>
        )}
      </Card>
    </>
  );
}

export default function GeneralLedgerPage() {
  return (
    <Suspense>
      <LedgerView />
    </Suspense>
  );
}
