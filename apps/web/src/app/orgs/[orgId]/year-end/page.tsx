'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import { YEAR_END_STATUS, type FiscalYearEnd, type YearEndClose, type YearEndOverview, type YearEndPreview } from '@/lib/year-end';

export default function YearEndPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [closing, setClosing] = useState<FiscalYearEnd | null>(null);
  const [reopening, setReopening] = useState<FiscalYearEnd | null>(null);
  const [done, setDone] = useState<YearEndClose | null>(null);
  const q = useQuery({ queryKey: ['year-end', orgId], queryFn: () => api<YearEndOverview>(`/v1/orgs/${orgId}/year-end`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['year-end', orgId] });
    await qc.invalidateQueries({ queryKey: ['journals', orgId] });
  };
  if (!org) return null;
  const o = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Year-end close"
        description="At the end of a fiscal year its revenue and expense accounts are brought to nil and the profit or loss moves to retained earnings, by one closing journal on the year's last day. The year's profit and loss report is unchanged; the balance sheet then shows the profit in retained earnings."
      />
      <ErrorAlert title="Could not load the fiscal years" error={q.error} />
      {done ? (
        <Alert tone="positive" title={`${done.reference}: ${done.label} closed`}>
          <Money value={done.toRetainedEarnings.replace('-', '')} currency={c} /> {Number(done.toRetainedEarnings) < 0 ? 'charged' : 'credited'} to {done.retainedEarningsAccount.code} {done.retainedEarningsAccount.name}.{' '}
          <Link className="text-accent underline" href={`/orgs/${orgId}/journals/${done.journalEntryId}`}>Open the closing journal</Link>
        </Alert>
      ) : null}
      {o ? (
        <>
          <Card className="mt-4">
            <CardHeader title="Fiscal years" description="Newest first. A year can be closed once it has ended and its last month is open. Close it again after a late adjustment: only the difference is posted." />
            <Table aria-label="Fiscal years">
              <thead>
                <tr><Th>Year</Th><Th>Months</Th><Th numeric>Profit</Th><Th numeric>In retained earnings</Th><Th numeric>Left to close</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr>
              </thead>
              <tbody>
                {o.years.map((y) => (
                  <Tr key={y.fiscalYear}>
                    <Td><span className="font-medium">{y.label}</span><span className="block text-xs text-fg-muted">{date(y.startDate)} to {date(y.endDate)}</span></Td>
                    <Td className="text-sm text-fg-muted">{y.periods.open} open{y.periods.locked ? `, ${y.periods.locked} locked` : ''}{y.periods.closed ? `, ${y.periods.closed} closed` : ''}</Td>
                    <Td numeric><Money value={y.profit} currency={c} signed /></Td>
                    <Td numeric><Money value={y.closedToRetainedEarnings} currency={c} signed /></Td>
                    <Td numeric><Money value={y.leftToClose} currency={c} signed /></Td>
                    <Td><Badge tone={YEAR_END_STATUS[y.status].tone}>{YEAR_END_STATUS[y.status].label}</Badge>{!y.ended ? <span className="block text-xs text-fg-muted">Ends {date(y.endDate)}</span> : null}</Td>
                    <Td className="whitespace-nowrap text-right">
                      {o.can.close && y.ended && (y.status === 'NOT_CLOSED' || y.status === 'OUT_OF_DATE') ? (
                        <Button size="sm" onClick={() => { setDone(null); setClosing(y); }}>{y.status === 'OUT_OF_DATE' ? 'Close again…' : 'Close the year…'}</Button>
                      ) : null}
                      {o.can.close && (y.status === 'CLOSED' || y.status === 'OUT_OF_DATE') ? (
                        <Button size="sm" variant="ghost" onClick={() => { setDone(null); setReopening(y); }}>Reopen…</Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card className="mt-6">
            <CardHeader title="Closes made" description="Every closing journal, newest first. Reopening a year reverses its closes with closing entries on the same date, so the accounts are as they were." />
            {o.closes.length === 0 ? (
              <EmptyState title="No year has been closed">Close a year above once it has ended.</EmptyState>
            ) : (
              <Table aria-label="Closes made">
                <thead>
                  <tr><Th>Close</Th><Th>Year</Th><Th>Retained earnings</Th><Th numeric>Profit then</Th><Th numeric>Posted</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {o.closes.map((x) => (
                    <Tr key={x.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${x.journalEntryId}`}>{x.reference}</Link><span className="block text-xs text-fg-muted">{x.createdBy ?? ''} · {date(x.createdAt.slice(0, 10))}</span></Td>
                      <Td>{x.label}<span className="block text-xs text-fg-muted">{x.memo ?? `Dated ${date(x.closingDate)}`}</span></Td>
                      <Td className="text-sm">{x.retainedEarningsAccount.code} {x.retainedEarningsAccount.name}</Td>
                      <Td numeric><Money value={x.profit} currency={c} signed /></Td>
                      <Td numeric><Money value={x.toRetainedEarnings} currency={c} signed /><span className="block text-xs text-fg-muted">{x.accounts} {x.accounts === 1 ? 'account' : 'accounts'}</span></Td>
                      <Td>
                        {x.status === 'ACTIVE' ? <Badge tone="positive">In force</Badge> : <Badge tone="neutral">Reversed</Badge>}
                        {x.reversalJournalEntryId ? <Link className="block text-xs text-accent hover:underline" href={`/orgs/${orgId}/journals/${x.reversalJournalEntryId}`}>{x.reversalReason}</Link> : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {closing ? <CloseDialog y={closing} o={o} onClose={() => setClosing(null)} onDone={async (x) => { setDone(x); await refresh(); }} /> : null}
          {reopening ? <ReopenDialog y={reopening} onClose={() => setReopening(null)} onDone={refresh} /> : null}
        </>
      ) : null}
    </>
  );
}

function CloseDialog({ y, o, onClose, onDone }: { y: FiscalYearEnd; o: YearEndOverview; onClose: () => void; onDone: (c: YearEndClose) => Promise<void> }) {
  const { orgId } = useOrg();
  const accounts = useAccounts();
  const [re, setRe] = useState(o.retainedEarningsAccountId ?? '');
  const [memo, setMemo] = useState('');
  const preview = useQuery({
    queryKey: ['year-end-preview', orgId, y.fiscalYear, re],
    queryFn: () => api<YearEndPreview>(`/v1/orgs/${orgId}/year-end/${y.fiscalYear}/preview${re ? `?retainedEarningsAccountId=${re}` : ''}`),
  });
  const m = useMutation({
    mutationFn: () => api<YearEndClose>(`/v1/orgs/${orgId}/year-end/${y.fiscalYear}/close`, { method: 'POST', body: { retainedEarningsAccountId: re, memo: memo || null } }),
    onSuccess: async (x) => { await onDone(x); onClose(); },
  });
  const equity = (accounts.data ?? []).filter((a) => a.type === 'EQUITY' && a.isPostable && a.isActive);
  const p = preview.data;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Close ${y.label}`} description={`A closing journal dated ${date(y.endDate)} in ${y.lastPeriod.name}${y.lastPeriod.status !== 'OPEN' ? `, which is ${y.lastPeriod.status.toLowerCase()}: open it first` : ''}.`}>
      <div className="flex flex-col gap-4">
        <Field label="Retained earnings account">{(f) => (
          <Select {...f} value={re} onChange={(e) => setRe(e.target.value)}>
            <option value="">Choose…</option>
            {equity.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        )}</Field>
        {p ? (
          <Table aria-label="Closing journal">
            <thead><tr><Th>Account</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></tr></thead>
            <tbody>
              {p.lines.map((l) => (
                <Tr key={l.accountId}>
                  <Td className="text-sm">{l.account}</Td>
                  <Td numeric>{l.debit !== '0.00' ? <Money value={l.debit} currency={o.currency} /> : ''}</Td>
                  <Td numeric>{l.credit !== '0.00' ? <Money value={l.credit} currency={o.currency} /> : ''}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {p ? (
          <p className="text-sm text-fg-muted">
            {Number(p.toRetainedEarnings) >= 0 ? 'Profit' : 'Loss'} moved to retained earnings: <Money value={p.toRetainedEarnings.replace('-', '')} currency={o.currency} />. The year&apos;s profit stays <Money value={p.profit} currency={o.currency} signed /> in the profit and loss report.
          </p>
        ) : null}
        <ErrorAlert title="Could not preview the close" error={preview.error} />
        <Field label="Note (optional)">{(f) => <Input {...f} maxLength={400} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. After the statutory audit" />}</Field>
        <ErrorAlert title="The year was not closed" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={m.isPending} disabled={!re || !p || p.lines.length === 0} onClick={() => m.mutate()}>Close the year</Button>
        </div>
      </div>
    </Dialog>
  );
}

function ReopenDialog({ y, onClose, onDone }: { y: FiscalYearEnd; onClose: () => void; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/year-end/${y.fiscalYear}/reopen`, { method: 'POST', body: { reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Reopen ${y.label}`} description={`Reverses every close of the year still in force, dated ${date(y.endDate)}. The profit goes back to the revenue and expense accounts until the year is closed again.`}>
      <div className="flex flex-col gap-4">
        <Field label="Reason">{(f) => <Input {...f} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Restating after the audit" />}</Field>
        <ErrorAlert title="The year was not reopened" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>Reopen the year</Button>
        </div>
      </div>
    </Dialog>
  );
}
