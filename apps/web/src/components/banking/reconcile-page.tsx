'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type Reconciliation, type ReconciliationPreview } from '@/lib/types';
import { useBankAccounts } from './accounts-page';

const amountRe = /^-?\d{0,18}(\.\d{0,2})?$/;

export function ReconcilePage() {
  const { org, orgId } = useOrg();
  const { accountId } = useParams<{ accountId: string }>();
  const accounts = useBankAccounts();
  const account = accounts.data?.find((a) => a.id === accountId);
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/banking`;
  const history = useQuery({ queryKey: ['reconciliations', orgId, accountId], queryFn: () => api<Reconciliation[]>(`${base}/accounts/${accountId}/reconciliations`) });
  const last = history.data?.find((r) => r.status === 'COMPLETED');
  const [statementDate, setStatementDate] = useState(today());
  const [statementBalance, setStatementBalance] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const body = () => ({ statementDate, statementBalance, ...(last ? {} : { openingBalance }) });
  const check = useMutation({ mutationFn: () => api<ReconciliationPreview>(`${base}/accounts/${accountId}/reconciliations/preview`, { method: 'POST', body: body() }) });
  const complete = useMutation({
    mutationFn: () => api<Reconciliation>(`${base}/accounts/${accountId}/reconciliations`, { method: 'POST', body: body() }),
    onSuccess: async () => {
      check.reset();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['reconciliations', orgId, accountId] }),
        qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] }),
        qc.invalidateQueries({ queryKey: ['bank-lines', orgId, accountId] }),
      ]);
    },
  });
  const [undoing, setUndoing] = useState<Reconciliation | null>(null);
  if (!org) return null;
  const c = org.functionalCurrency;
  const p = check.data;
  const ready = !!statementBalance && (!!last || !!openingBalance);
  return (
    <>
      <PageHeader
        title={`Reconcile${account ? ` · ${account.code} ${account.name}` : ''}`}
        description="Enter the closing balance from your bank statement. The account reconciles when every statement line up to that date is matched or excluded, and the balance in the books, less items the bank has not seen yet, equals the statement."
        actions={<Link href={`/orgs/${orgId}/banking/${accountId}`}><Button variant="secondary">Back to statement lines</Button></Link>}
      />
      {complete.data ? <div className="mb-4"><Alert tone="positive" title={`Reconciled to ${date(complete.data.statementDate)}`}>{complete.data.lines} statement lines are now locked. Undo the reconciliation to change them.</Alert></div> : null}
      <Card className="mb-6 p-5">
        <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); check.mutate(); }}>
          <Field label="Statement date">{(f) => <Input {...f} type="date" required max={today()} min={last ? last.statementDate : undefined} value={statementDate} onChange={(e) => { check.reset(); setStatementDate(e.target.value); }} />}</Field>
          {last ? (
            <Field label="Opening balance" hint={`From the reconciliation to ${date(last.statementDate)}.`}>{(f) => <Input {...f} disabled value={last.statementBalance} />}</Field>
          ) : (
            <Field label="Opening balance" hint="The opening balance on your first statement.">
              {(f) => <Input {...f} required inputMode="decimal" value={openingBalance} onChange={(e) => { if (amountRe.test(e.target.value)) { check.reset(); setOpeningBalance(e.target.value); } }} />}
            </Field>
          )}
          <Field label="Closing balance on the statement">
            {(f) => <Input {...f} required inputMode="decimal" value={statementBalance} onChange={(e) => { if (amountRe.test(e.target.value)) { check.reset(); setStatementBalance(e.target.value); } }} />}
          </Field>
          <div className="flex items-end"><Button type="submit" variant="secondary" disabled={!ready} loading={check.isPending}>Check</Button></div>
        </form>
        {check.error ? <div className="mt-4"><Alert title="Could not check">{check.error.message}</Alert></div> : null}
      </Card>

      {p ? (
        <div className="mb-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Statement" description={`${date(p.startDate)} to ${date(p.statementDate)} · ${p.linesInRange} line${p.linesInRange === 1 ? '' : 's'}`} />
            <dl className="divide-y divide-line text-sm">
              <Row label="Opening balance" value={<Money value={p.openingBalance} currency={c} signed />} />
              <Row label="Opening balance plus imported lines" value={<Money value={p.computedStatementBalance} currency={c} signed />} />
              <Row label="Closing balance you entered" value={<Money value={p.statementBalance} currency={c} signed />} strong />
            </dl>
          </Card>
          <Card>
            <CardHeader title="Books" description={`Bank account balance on ${date(p.statementDate)}`} />
            <dl className="divide-y divide-line text-sm">
              <Row label="Balance in the books" value={<Money value={p.ledgerBalance} currency={c} signed />} />
              <Row label="Less items not on the statement yet" value={<Money value={p.uncleared} currency={c} signed />} />
              <Row label="Difference" value={<span className={p.difference === '0.00' ? 'text-positive' : 'text-negative'}><Money value={p.difference} currency={c} /></span>} strong />
            </dl>
          </Card>
          <div className="lg:col-span-2">
            {p.canComplete ? (
              <Alert tone="positive" title="Ready to reconcile">
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <span>Completing locks the {p.linesInRange} statement lines up to {date(p.statementDate)}.</span>
                  {can(org.role, 'banking.reconcile') ? <Button loading={complete.isPending} onClick={() => complete.mutate()}>Complete reconciliation</Button> : <span>Your role cannot complete reconciliations.</span>}
                </div>
              </Alert>
            ) : (
              <Alert tone="warning" title="Not reconciled yet">
                <ul className="mt-1 list-disc pl-5">{p.issues.map((i) => <li key={i}>{i}</li>)}</ul>
              </Alert>
            )}
            {complete.error ? <div className="mt-3"><Alert title="Could not complete">{[complete.error.message, ...(complete.error instanceof ApiError ? complete.error.issues : [])].join(' · ')}</Alert></div> : null}
          </div>
          {p.unmatchedLines.length ? (
            <Card className="lg:col-span-2">
              <CardHeader title="Statement lines to review" actions={<Link href={`/orgs/${orgId}/banking/${accountId}`}><Button size="sm" variant="secondary">Review lines</Button></Link>} />
              <Table>
                <thead><tr><Th>Date</Th><Th>Description</Th><Th numeric>Amount</Th></tr></thead>
                <tbody>{p.unmatchedLines.map((l) => <Tr key={l.id}><Td>{date(l.date)}</Td><Td>{l.description}</Td><Td numeric><Money value={l.amount} currency={c} signed /></Td></Tr>)}</tbody>
              </Table>
            </Card>
          ) : null}
          <Card className="lg:col-span-2">
            <CardHeader title="In the books, not on the statement yet" description="Deposits in transit and payments the bank has not processed. They stay outstanding until a later statement line matches them." />
            {p.unclearedLines.length ? (
              <Table>
                <thead><tr><Th>Entry</Th><Th>Date</Th><Th>Memo</Th><Th numeric>Amount</Th></tr></thead>
                <tbody>
                  {p.unclearedLines.map((l) => (
                    <Tr key={l.journalLineId}>
                      <Td className="num"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${l.entryId}`}>{l.entryNumber}</Link></Td>
                      <Td>{date(l.date)}</Td>
                      <Td className="text-fg-muted">{l.memo ?? l.description ?? ''}</Td>
                      <Td numeric><Money value={l.amount} currency={c} signed /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : <p className="px-5 py-4 text-sm text-fg-muted">None.</p>}
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader title="Reconciliation history" />
        {history.data && history.data.length === 0 ? <p className="px-5 py-4 text-sm text-fg-muted">This account has not been reconciled yet.</p> : null}
        {history.data?.length ? (
          <Table>
            <thead><tr><Th>Statement date</Th><Th numeric>Statement balance</Th><Th numeric>Books</Th><Th numeric>Outstanding</Th><Th>Lines</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {history.data.map((r) => (
                <Tr key={r.id}>
                  <Td>{date(r.statementDate)}</Td>
                  <Td numeric><Money value={r.statementBalance} currency={c} signed /></Td>
                  <Td numeric><Money value={r.ledgerBalance} currency={c} signed /></Td>
                  <Td numeric><Money value={r.uncleared} currency={c} signed /></Td>
                  <Td>{r.status === 'COMPLETED' ? r.lines : '—'}</Td>
                  <Td>{r.status === 'COMPLETED' ? <Badge tone="positive">Reconciled</Badge> : <span><Badge>Undone</Badge> <span className="text-xs text-fg-muted">{r.undoReason}</span></span>}</Td>
                  <Td className="text-right">{r.id === last?.id && can(org.role, 'periods.lock') ? <Button size="sm" variant="ghost" onClick={() => setUndoing(r)}>Undo…</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
      {undoing ? <UndoDialog rec={undoing} onClose={() => setUndoing(null)} /> : null}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-5 py-3 ${strong ? 'font-semibold' : ''}`}>
      <dt className="text-fg-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UndoDialog({ rec, onClose }: { rec: Reconciliation; onClose: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const undo = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/banking/reconciliations/${rec.id}/undo`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['reconciliations', orgId] }), qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] }), qc.invalidateQueries({ queryKey: ['bank-lines', orgId] })]);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Undo the reconciliation to ${date(rec.statementDate)}`} description="Its statement lines become editable again. The reconciliation stays in the history, marked undone.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); undo.mutate(); }}>
        {undo.error ? <Alert title="Could not undo">{undo.error.message}</Alert> : null}
        <Field label="Reason" hint="Kept in the audit trail.">{(f) => <Input {...f} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={undo.isPending}>Undo reconciliation</Button>
        </div>
      </form>
    </Dialog>
  );
}
