'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupplierStatementLine } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { type StatementFormValue, SupplierStatementForm } from '@/components/purchases/supplier-statement-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type ItemKind = 'BILL' | 'VENDOR_CREDIT' | 'PAYMENT' | 'BILL_VOID' | 'VENDOR_CREDIT_VOID' | 'PAYMENT_VOID';
interface Statement {
  id: string;
  contact: { id: string; name: string };
  currency: string;
  from: string;
  to: string;
  status: 'OPEN' | 'RECONCILED';
  note: string | null;
  lines: (SupplierStatementLine & { description: string | null })[];
  books: { id: string; kind: ItemKind; number: string; date: string; reference: string | null; amount: string }[];
  matches: { line: number; itemId: string; itemNumber: string; itemKind: ItemKind; by: 'REFERENCE' | 'AMOUNT_AND_DATE'; theirs: string; ours: string; difference: string }[];
  onlyOnStatement: { line: number; date: string; reference: string; kind: SupplierStatementLine['kind']; amount: string; effect: string; action: string }[];
  onlyInBooks: { id: string; kind: ItemKind; number: string; date: string; reference: string | null; effect: string; action: string }[];
  balances: { theirOpening: string; ourOpening: string; theirClosing: string; ourClosing: string; difference: string };
  explained: { opening: string; onlyOnStatement: string; onlyInBooks: string; amountDifferences: string; statementArithmetic: string };
  statementAddsUp: boolean;
  agrees: boolean;
  canReconcile: boolean;
  createdBy: string;
  updatedBy: string;
  reconciledBy: string | null;
  reconciledAt: string | null;
}
const LINE_KIND = { INVOICE: 'Invoice', DEBIT_NOTE: 'Debit note', CREDIT_NOTE: 'Credit note', PAYMENT: 'Payment' } as const;
const ITEM_KIND: Record<ItemKind, string> = { BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit', PAYMENT: 'Payment', BILL_VOID: 'Bill voided', VENDOR_CREDIT_VOID: 'Vendor credit voided', PAYMENT_VOID: 'Payment voided' };

/** One supplier statement reconciled against the books (AP-011). */
export default function SupplierStatementPage() {
  const { org, orgId } = useOrg();
  const { statementId } = useParams<{ statementId: string }>();
  const qc = useQueryClient();
  const key = ['supplier-statement', orgId, statementId];
  const url = `/v1/orgs/${orgId}/purchases/supplier-statements/${statementId}`;
  const q = useQuery({ queryKey: key, queryFn: () => api<Statement>(url) });
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const done = (s: Statement) => {
    qc.setQueryData(key, s);
    void qc.invalidateQueries({ queryKey: ['supplier-statements', orgId] });
  };
  const update = useMutation({ mutationFn: (v: StatementFormValue) => api<Statement>(url, { method: 'PUT', body: { ...v, contactId: q.data!.contact.id } }), onSuccess: (s) => { done(s); setEditing(false); } });
  const reconcile = useMutation({ mutationFn: () => api<Statement>(`${url}/reconcile`, { method: 'POST', body: { note } }), onSuccess: done });
  if (!org) return null;
  const s = q.data;
  const manage = can(org.role, 'purchases.manage');
  const itemHref = (kind: ItemKind, id: string) => (kind.startsWith('PAYMENT') ? `/orgs/${orgId}/purchases/payments/${id}` : `/orgs/${orgId}/purchases/bills/${id}`);
  const m = (v: string) => <Money value={v} currency={s?.currency ?? org.functionalCurrency} />;
  return (
    <>
      <PageHeader
        title={s ? `Statement from ${s.contact.name}` : 'Supplier statement'}
        description={s ? `${date(s.from)} to ${date(s.to)}. Entered by ${s.createdBy}. Amounts are what you owe them: invoices raise it, credit notes and payments lower it.` : undefined}
        actions={<Link className="text-sm underline" href={`/orgs/${orgId}/purchases/supplier-statements`}>All statements</Link>}
      />
      <ErrorAlert title="Could not load the statement" error={q.error} />
      {s ? (
        <>
          <div className="mb-4">
            {s.status === 'RECONCILED' ? (
              <Alert tone="positive" title={`Reconciled by ${s.reconciledBy} on ${date(s.reconciledAt!.slice(0, 10))}`}>{s.note ?? 'The statement agreed with the books.'}</Alert>
            ) : !s.statementAddsUp ? (
              <Alert tone="negative" title="The statement does not add up">Its lines come to {m(s.explained.statementArithmetic)} less than the closing balance as entered. Check the balances and lines against their statement and correct them.</Alert>
            ) : s.agrees ? (
              <Alert tone="positive" title="Their statement agrees with your books">Every line matches and the balances are the same.</Alert>
            ) : (
              <Alert tone="warning" title={`They show ${s.currency} ${s.balances.difference.replace(/^-/, '')} ${s.balances.difference.startsWith('-') ? 'less' : 'more'} than your books`}>Every rupee of the difference is traced below. Enter what is missing, chase what they have not recorded, then mark the statement reconciled with a note.</Alert>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <Card className="p-4"><p className="text-sm text-fg-muted">Their closing balance</p><p className="mt-1 text-2xl font-semibold">{m(s.balances.theirClosing)}</p><p className="text-xs text-fg-muted">Opening {m(s.balances.theirOpening)}</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Your books</p><p className="mt-1 text-2xl font-semibold">{m(s.balances.ourClosing)}</p><p className="text-xs text-fg-muted">Opening {m(s.balances.ourOpening)}</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Difference</p><p className={`mt-1 text-2xl font-semibold ${s.balances.difference === '0.00' ? '' : 'text-warning'}`}>{m(s.balances.difference)}</p><p className="text-xs text-fg-muted">Theirs less yours</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Lines matched</p><p className="mt-1 text-2xl font-semibold">{s.matches.length} of {s.lines.length}</p><p className="text-xs text-fg-muted">{s.onlyInBooks.length} item{s.onlyInBooks.length === 1 ? '' : 's'} only in your books</p></Card>
          </div>

          <Card className="mt-6" role="region" aria-label="Where the difference comes from">
            <CardHeader title="Where the difference comes from" description="These add up to the whole difference between their closing balance and your books." />
            <Table aria-label="Where the difference comes from">
              <tbody>
                <Tr><Td>Different opening balance</Td><Td numeric>{m(s.explained.opening)}</Td></Tr>
                <Tr><Td>Lines only on their statement</Td><Td numeric>{m(s.explained.onlyOnStatement)}</Td></Tr>
                <Tr><Td>Items only in your books</Td><Td numeric>{m(s.explained.onlyInBooks)}</Td></Tr>
                <Tr><Td>Matched amounts that differ</Td><Td numeric>{m(s.explained.amountDifferences)}</Td></Tr>
                <Tr><Td>Their statement does not add up</Td><Td numeric>{m(s.explained.statementArithmetic)}</Td></Tr>
                <Tr className="font-semibold"><Td>Difference</Td><Td numeric>{m(s.balances.difference)}</Td></Tr>
              </tbody>
            </Table>
          </Card>

          <Card className="mt-6" role="region" aria-label="Only on their statement">
            <CardHeader title="Only on their statement" description="Lines with no bill, vendor credit or payment in your books for the period." />
            {s.onlyOnStatement.length ? (
              <Table aria-label="Only on their statement">
                <thead><Tr><Th>Date</Th><Th>Their reference</Th><Th>Type</Th><Th numeric>Amount</Th><Th>What to do</Th></Tr></thead>
                <tbody>
                  {s.onlyOnStatement.map((l) => (
                    <Tr key={l.line}><Td className="whitespace-nowrap align-top">{date(l.date)}</Td><Td className="align-top">{l.reference}</Td><Td className="align-top">{LINE_KIND[l.kind]}</Td><Td numeric className="align-top">{m(l.amount)}</Td><Td className="align-top"><span className="block max-w-md">{l.action}</span></Td></Tr>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="Nothing missing from your books">Every line on their statement is in your books.</EmptyState>}
          </Card>

          <Card className="mt-6" role="region" aria-label="Only in your books">
            <CardHeader title="Only in your books" description="Bills, vendor credits and payments in the period that are not on their statement." />
            {s.onlyInBooks.length ? (
              <Table aria-label="Only in your books">
                <thead><Tr><Th>Date</Th><Th>Item</Th><Th>Reference</Th><Th numeric>Effect</Th><Th>What to do</Th></Tr></thead>
                <tbody>
                  {s.onlyInBooks.map((i) => (
                    <Tr key={`${i.id}${i.kind}`}><Td className="whitespace-nowrap align-top">{date(i.date)}</Td><Td className="whitespace-nowrap align-top"><Link className="underline" href={itemHref(i.kind, i.id)}>{i.number}</Link><span className="block text-xs text-fg-muted">{ITEM_KIND[i.kind]}</span></Td><Td className="align-top">{i.reference ?? '—'}</Td><Td numeric className="align-top">{m(i.effect)}</Td><Td className="align-top"><span className="block max-w-md">{i.action}</span></Td></Tr>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="Nothing missing from their statement">Every item in your books for the period is on their statement.</EmptyState>}
          </Card>

          <Card className="mt-6" role="region" aria-label="Lines matched">
            <CardHeader title="Lines matched" description="Each line on their statement and the item in your books it matches: by their reference (ignoring separators and leading zeros), else by the same amount within a few days." />
            {s.matches.length ? (
              <Table aria-label="Lines matched">
                <thead><Tr><Th>Their line</Th><Th>Your item</Th><Th>Matched by</Th><Th numeric>Theirs</Th><Th numeric>Yours</Th><Th numeric>Difference</Th></Tr></thead>
                <tbody>
                  {s.matches.map((x) => {
                    const l = s.lines[x.line]!;
                    return (
                      <Tr key={x.line}>
                        <Td className="align-top">{l.reference}<span className="block text-xs text-fg-muted">{LINE_KIND[l.kind]}, {date(l.date)}</span></Td>
                        <Td className="whitespace-nowrap align-top"><Link className="underline" href={itemHref(x.itemKind, x.itemId)}>{x.itemNumber}</Link></Td>
                        <Td className="align-top">{x.by === 'REFERENCE' ? 'Reference' : 'Amount and date'}</Td>
                        <Td numeric className="align-top">{m(x.theirs)}</Td>
                        <Td numeric className="align-top">{m(x.ours)}</Td>
                        <Td numeric className="align-top">{x.difference === '0.00' ? <span className="text-fg-faint">—</span> : <Badge tone="warning">{s.currency} {x.difference}</Badge>}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            ) : <EmptyState title="No lines matched">None of their lines matches an item in your books for the period.</EmptyState>}
          </Card>

          {s.status === 'OPEN' && manage ? (
            <>
              <Card className="mt-6" role="region" aria-label="Mark reconciled">
                <CardHeader title="Mark reconciled" description={s.agrees ? 'The statement agrees with your books.' : 'Say what will happen to each difference: what you will enter, ask for or send them. The statement is then fixed.'} />
                <ErrorAlert title="Not reconciled" error={reconcile.error} />
                <div className="grid gap-3 p-4">
                  <Field label="Note" hint={s.agrees ? 'Optional' : 'Needed while differences remain'}>{(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                  <div className="flex gap-3">
                    <Button disabled={!s.canReconcile || reconcile.isPending || (!s.agrees && !note.trim())} onClick={() => reconcile.mutate()}>Mark reconciled</Button>
                    <Button variant="secondary" onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? 'Cancel correction' : 'Correct the statement as entered'}</Button>
                  </div>
                </div>
              </Card>
              {editing ? (
                <Card className="mt-6" role="region" aria-label="Correct the statement">
                  <CardHeader title="Correct the statement" description="Fix a mistake in entering it: the balances or lines as they appear on their statement." />
                  <ErrorAlert title="Not saved" error={update.error} />
                  <SupplierStatementForm initial={{ contactId: s.contact.id, from: s.from, to: s.to, theirOpening: s.balances.theirOpening, theirClosing: s.balances.theirClosing, lines: s.lines }} submitLabel="Save and reconcile again" pending={update.isPending} onSubmit={(v) => update.mutate(v)} />
                </Card>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
