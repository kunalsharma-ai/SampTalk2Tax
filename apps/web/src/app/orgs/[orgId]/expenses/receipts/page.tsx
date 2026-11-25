'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RECEIPT_MATCH_CONFIDENCE_LABEL } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { CONFIDENCE_TONE, RECEIPT_STATUS, type ExpenseReceipt, type ReceiptBankLine, type ReceiptList } from '@/components/expenses/receipts';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { ReceiptReader } from '@/components/expenses/receipt-reader';
import { api, uploadFile } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Missing {
  from: string;
  days: number;
  lines: number;
  withReceipt: number;
  totals: { currency: string; amount: string }[];
  items: (ReceiptBankLine & { suggestion: { receipt: { id: string; reference: string; merchant: string; date: string; amount: string }; score: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[] } | null })[];
}

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10); // not money

/** Expenses → Receipt matching (EXP-019): receipts for company-paid spending, matched to bank lines. */
export default function ReceiptsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [merchant, setMerchant] = useState('');
  const [day, setDay] = useState(todayIst());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState('90');
  /** The file just read, attached to the receipt once it is added. */
  const [file, setFile] = useState<File | null>(null);
  const base = `/v1/orgs/${orgId}/expense-receipts`;
  const q = useQuery({ queryKey: ['expense-receipts', orgId], queryFn: () => api<ReceiptList>(base) });
  const seeBank = !!org && can(org.role, 'banking.read');
  const missing = useQuery({ queryKey: ['expense-receipts-missing', orgId, days], queryFn: () => api<Missing>(`${base}/missing?days=${days}`), enabled: seeBank });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['expense-receipts', orgId] }), qc.invalidateQueries({ queryKey: ['expense-receipts-missing', orgId] })]);
  const add = useMutation({
    mutationFn: async () => {
      const r = await api<ExpenseReceipt>(base, { method: 'POST', body: { merchant, date: day, amount, note: note || null } });
      if (file) await uploadFile(`/v1/orgs/${orgId}/attachments?entityType=EXPENSE_RECEIPT&entityId=${r.id}&fileName=${encodeURIComponent(file.name)}`, file);
      return r;
    },
    onSuccess: (r) => { void refresh(); router.push(`/orgs/${orgId}/expenses/receipts/${r.id}`); } });
  const match = useMutation({ mutationFn: (v: { id: string; lineId: string }) => api<ExpenseReceipt>(`${base}/${v.id}/match`, { method: 'POST', body: { statementLineId: v.lineId } }), onSuccess: () => refresh() });
  const sure = useMutation({ mutationFn: () => api<{ matched: number }>(`${base}/match-sure`, { method: 'POST' }), onSuccess: () => refresh() });
  if (!org) return null;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Receipt matching"
        description="Receipts for spending paid from a company bank or card account. Upload each receipt with what it says; finance matches it to the money-out line of the bank statement it paid, from suggestions based on the amount, the date and the merchant's name in the bank narration. Spending you paid yourself goes on an expense claim instead."
        actions={d?.canMatch && d.summary.sure ? <Button loading={sure.isPending} onClick={() => sure.mutate()}>Match {d.summary.sure} sure {d.summary.sure === 1 ? 'one' : 'ones'}</Button> : null}
      />
      <ErrorAlert title="Could not load receipts" error={q.error} />
      <ErrorAlert title="The receipts were not matched" error={sure.error} />
      {sure.data ? <div className="mb-4"><Alert tone="positive" title={`${sure.data.matched} receipt${sure.data.matched === 1 ? '' : 's'} matched`}>Each is now linked to its bank line. Undo one from the receipt if it is wrong.</Alert></div> : null}
      <Card role="region" aria-label="Add a receipt">
        <CardHeader title="Add a receipt" description="Read the photo or PDF to fill in what it says, or type it. A receipt that was read is attached for you; otherwise attach it on the next screen." />
        <div className="px-4 pt-4">
          <ReceiptReader
            onRead={(r, f) => {
              const g = r.reading;
              if (g.merchant) setMerchant(g.merchant.value);
              if (g.date) setDay(g.date.value);
              if (g.total) setAmount(g.total.value);
              setFile(f);
            }}
          />
        </div>
        <form className="grid gap-3 p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Merchant">{(p) => <Input {...p} required maxLength={200} value={merchant} onChange={(e) => setMerchant(e.target.value)} />}</Field>
          <Field label="Date on the receipt">{(p) => <Input {...p} type="date" required max={todayIst()} value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
          <Field label={`Amount (${org.functionalCurrency})`}>{(p) => <Input {...p} required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Note" hint="Optional">{(p) => <Textarea {...p} rows={1} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <div className="sm:col-span-4"><Button type="submit" loading={add.isPending}>Add receipt</Button></div>
        </form>
        <div className="px-4 pb-4"><ErrorAlert title="The receipt was not added" error={add.error} /></div>
      </Card>
      {d ? (
        <Card className="mt-6" role="region" aria-label="Uploaded receipts">
          <CardHeader title="Uploaded receipts" description={d.canMatch ? `${d.summary.unmatched} not matched, ${d.summary.matched} matched. Suggestions say how sure they are and why.` : 'The receipts you uploaded and whether finance has matched them.'} />
          {d.items.length ? (
            <Table aria-label="Uploaded receipts">
              <thead><Tr><Th>Receipt</Th><Th>Date</Th><Th numeric>Amount</Th><Th>Status</Th><Th>Bank line</Th></Tr></thead>
              <tbody>
                {d.items.map((r) => (
                  <Tr key={r.id}>
                    <Td className="align-top"><Link className="text-accent" href={`/orgs/${orgId}/expenses/receipts/${r.id}`}>{r.reference}</Link> {r.merchant}<span className="block text-xs text-fg-muted">{r.uploadedBy.name}{r.files.length ? '' : ' · no file yet'}</span></Td>
                    <Td className="align-top">{date(r.date)}</Td>
                    <Td numeric className="align-top"><Money value={r.amount} currency={r.currency} /></Td>
                    <Td className="align-top"><Badge tone={RECEIPT_STATUS[r.status].tone}>{RECEIPT_STATUS[r.status].label}</Badge></Td>
                    <Td className="align-top text-sm">
                      {r.matchedLine ? (
                        <>{r.matchedLine.description}<span className="block text-xs text-fg-muted">{r.matchedLine.account.name}, {date(r.matchedLine.date)}</span></>
                      ) : r.suggestion ? (
                        <>
                          <Badge tone={CONFIDENCE_TONE[r.suggestion.confidence]}>{RECEIPT_MATCH_CONFIDENCE_LABEL[r.suggestion.confidence]}</Badge> {r.suggestion.line.description}
                          <span className="block text-xs text-fg-muted">{r.suggestion.line.account.name}, {date(r.suggestion.line.date)}, <Money value={r.suggestion.line.amount} currency={r.suggestion.line.currency} /></span>
                          <span className="block max-w-md text-xs text-fg-muted">{r.suggestion.reasons.join('. ')}</span>
                          {d.canMatch ? <Button className="mt-1" size="sm" variant="secondary" disabled={!r.files.length} loading={match.isPending && match.variables?.id === r.id} onClick={() => match.mutate({ id: r.id, lineId: r.suggestion!.line.id })} aria-label={`Match ${r.reference}`}>{r.files.length ? 'Match' : 'Attach the file first'}</Button> : null}
                        </>
                      ) : r.status === 'UNMATCHED' && d.canMatch ? <span className="text-fg-muted">No bank line fits yet</span> : <span className="text-fg-muted">–</span>}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No receipts yet">Add the first receipt above.</EmptyState>
          )}
          <div className="px-4 pb-4"><ErrorAlert title="The receipt was not matched" error={match.error} /></div>
        </Card>
      ) : null}
      {seeBank ? (
        <Card className="mt-6" role="region" aria-label="Bank spending without a receipt">
          <CardHeader
            title="Bank spending without a receipt"
            description={missing.data ? <>{missing.data.items.length} of {missing.data.lines} payments out since {date(missing.data.from)} have no receipt{missing.data.totals.map((t, i) => <span key={t.currency}>{i ? ', ' : ': '}<Money value={t.amount} currency={t.currency} /></span>)}.</> : 'Money paid out from imported bank statements with no receipt matched or attached.'}
            actions={<div className="w-44"><Select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)}>{[30, 90, 180, 365].map((n) => <option key={n} value={n}>Last {n} days</option>)}</Select></div>}
          />
          <ErrorAlert title="Could not load bank spending" error={missing.error} />
          {missing.data?.items.length ? (
            <Table aria-label="Bank spending without a receipt">
              <thead><Tr><Th>Date</Th><Th>Bank line</Th><Th numeric>Amount</Th><Th>Best receipt</Th></Tr></thead>
              <tbody>
                {missing.data.items.map((l) => (
                  <Tr key={l.id}>
                    <Td className="align-top">{date(l.date)}</Td>
                    <Td className="align-top">{l.description}<span className="block text-xs text-fg-muted">{l.account.name}</span></Td>
                    <Td numeric className="align-top"><Money value={l.amount} currency={l.currency} /></Td>
                    <Td className="align-top text-sm">{l.suggestion ? <><Badge tone={CONFIDENCE_TONE[l.suggestion.confidence]}>{RECEIPT_MATCH_CONFIDENCE_LABEL[l.suggestion.confidence]}</Badge> <Link className="text-accent" href={`/orgs/${orgId}/expenses/receipts/${l.suggestion.receipt.id}`}>{l.suggestion.receipt.reference}</Link> {l.suggestion.receipt.merchant}</> : <span className="text-fg-muted">Ask who paid for the receipt</span>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : missing.data ? (
            <EmptyState title="Every payment has a receipt">Nothing paid out in this period is missing one.</EmptyState>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
