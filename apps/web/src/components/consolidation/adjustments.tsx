'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import type { AccountType, Adjustment } from '@/lib/consolidation';
import { date, today } from '@/lib/format';

const TYPES: [AccountType, string][] = [
  ['ASSET', 'Asset'],
  ['LIABILITY', 'Liability'],
  ['EQUITY', 'Equity'],
  ['REVENUE', 'Revenue'],
  ['EXPENSE', 'Expense'],
];
type Draft = { code: string; name: string; type: AccountType | ''; debit: string; credit: string };
const blank = (): Draft => ({ code: '', name: '', type: '', debit: '', credit: '' });
const amount = (s: string) => {
  try {
    return s.trim() ? new D(s.trim()) : new D(0);
  } catch {
    return new D(0);
  }
};

/** The Adjustments tab (GL-034): entries in the consolidation only, such as goodwill. */
export function AdjustmentsTab({ orgId, groupId, base, manage, currency }: { orgId: string; groupId: string; base: string; manage: boolean; currency: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['consolidation-adjustments', orgId, groupId], queryFn: () => api<Adjustment[]>(`${base}/adjustments`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['consolidation-adjustments', orgId, groupId] });
    void qc.invalidateQueries({ queryKey: ['consolidation-report', orgId, groupId] });
  };
  const [d, setD] = useState({ date: today(), description: '' });
  const [lines, setLines] = useState<Draft[]>([blank(), blank()]);
  const add = useMutation({
    mutationFn: () => api<Adjustment>(`${base}/adjustments`, { method: 'POST', body: { ...d, lines } }),
    onSuccess: () => {
      setD({ date: today(), description: '' });
      setLines([blank(), blank()]);
      refresh();
    },
  });
  const voidIt = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api<Adjustment>(`${base}/adjustments/${id}/void`, { method: 'POST', body: { reason } }), onSuccess: refresh });
  const debits = lines.reduce((s, l) => s.plus(amount(l.debit)), new D(0));
  const credits = lines.reduce((s, l) => s.plus(amount(l.credit)), new D(0));
  const set = (i: number, patch: Partial<Draft>) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <CardHeader title="Consolidation adjustments" description="Entries made in the consolidation only, such as goodwill on acquisition or unrealised profit in stock. They show in the worksheet's Adjustments column; no company's books change." />
        <ErrorAlert title="Could not load the adjustments" error={list.error} />
        <ErrorAlert title="Could not void the adjustment" error={voidIt.error} />
        {list.data && !list.data.length ? <EmptyState title="No adjustments yet">Record goodwill, fair value or unrealised profit adjustments here.</EmptyState> : null}
        {list.data?.length ? (
          <Table aria-label="Consolidation adjustments">
            <thead><tr><Th>Reference</Th><Th>Date</Th><Th>Description</Th><Th>Lines</Th><Th numeric>Total</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {list.data.map((a) => (
                <Tr key={a.id}>
                  <Td className="num whitespace-nowrap">{a.reference}</Td>
                  <Td className="whitespace-nowrap">{date(a.date)}</Td>
                  <Td>{a.description}{a.voidReason ? <span className="block text-xs text-fg-faint">Voided: {a.voidReason}</span> : null}</Td>
                  <Td className="text-xs">
                    {a.lines.map((l, i) => (
                      <span key={i} className="block whitespace-nowrap">
                        <span className="num text-fg-muted">{l.code}</span> {l.name}: {new D(l.debit).isZero() ? <>Cr <Money value={l.credit} currency={currency} /></> : <>Dr <Money value={l.debit} currency={currency} /></>}
                      </span>
                    ))}
                  </Td>
                  <Td numeric><Money value={a.total} currency={currency} /></Td>
                  <Td>{a.status === 'VOID' ? <Badge tone="neutral">Void</Badge> : <Badge tone="positive">Posted</Badge>}</Td>
                  <Td>
                    {manage && a.status === 'POSTED' ? (
                      <Button size="sm" variant="ghost" aria-label={`Void ${a.reference}`} disabled={voidIt.isPending} onClick={() => { const reason = prompt(`Why is ${a.reference} being voided?`); if (reason) voidIt.mutate({ id: a.id, reason }); }}>
                        Void
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
      {manage ? (
        <Card className="p-4">
          <CardHeader title="Record a consolidation adjustment" description={`A balanced entry in ${currency}. Use the companies' account codes, or a new code such as goodwill to add an account to the consolidation.`} />
          <ErrorAlert title="The adjustment was not recorded" error={add.error} />
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <div className="flex flex-wrap gap-2">
              <Field label="Adjustment date">{(p) => <Input {...p} type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className="w-44" />}</Field>
              <Field label="Description">{(p) => <Input {...p} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} className="w-96" maxLength={200} placeholder="Goodwill on acquisition of …" />}</Field>
            </div>
            <Table aria-label="Adjustment lines">
              <thead><tr><Th>Account code</Th><Th>Account name</Th><Th>Type</Th><Th numeric>Debit</Th><Th numeric>Credit</Th><Th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <Tr key={i}>
                    <Td><Input aria-label={`Line ${i + 1} code`} value={l.code} onChange={(e) => set(i, { code: e.target.value })} className="w-28" maxLength={20} /></Td>
                    <Td><Input aria-label={`Line ${i + 1} name`} value={l.name} onChange={(e) => set(i, { name: e.target.value })} className="w-56" maxLength={120} /></Td>
                    <Td>
                      <Select aria-label={`Line ${i + 1} type`} value={l.type} onChange={(e) => set(i, { type: e.target.value as AccountType })} className="w-36">
                        <option value="">Type…</option>
                        {TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                      </Select>
                    </Td>
                    <Td numeric><Input aria-label={`Line ${i + 1} debit`} inputMode="decimal" value={l.debit} onChange={(e) => set(i, { debit: e.target.value })} className="w-32 text-right" /></Td>
                    <Td numeric><Input aria-label={`Line ${i + 1} credit`} inputMode="decimal" value={l.credit} onChange={(e) => set(i, { credit: e.target.value })} className="w-32 text-right" /></Td>
                    <Td>{lines.length > 2 ? <Button type="button" size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))}>Remove</Button> : null}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td colSpan={3} className="font-semibold">Total {debits.equals(credits) ? null : <span className="ml-2 text-xs font-normal text-negative">Debits and credits differ by {debits.minus(credits).abs().toFixed(2)}</span>}</Td>
                  <Td numeric className="font-semibold">{debits.toFixed(2)}</Td>
                  <Td numeric className="font-semibold">{credits.toFixed(2)}</Td>
                  <Td />
                </tr>
              </tfoot>
            </Table>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setLines((xs) => [...xs, blank()])} disabled={lines.length >= 50}>Add a line</Button>
              <Button type="submit" loading={add.isPending} disabled={!d.description.trim() || debits.isZero() || !debits.equals(credits)}>Record adjustment</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
