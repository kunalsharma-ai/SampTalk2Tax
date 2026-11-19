'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Suggestion = {
  key: string;
  kind: 'REPEAT' | 'ACCRUAL';
  title: string;
  reason: string;
  date: string;
  memo: string;
  total: string;
  history: { month: string; amount: string }[];
  basedOn: { id: string; entryNumber: number | null; date: string }[];
  lines: { accountId: string; accountCode: string; accountName: string; debit: string; credit: string }[];
};
type Decision = { id: string; key: string; kind: 'REPEAT' | 'ACCRUAL'; action: 'ACCEPTED' | 'DISMISSED'; title: string; total: string; reason: string | null; createdAt: string; journal: { id: string; entryNumber: number | null; status: string | null } | null };
type Result = { month: string; suggestions: Suggestion[]; notes: string[]; decisions: Decision[] };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
function previousMonth(d: string): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const KIND: Record<Suggestion['kind'], string> = { REPEAT: 'Missed repeat', ACCRUAL: 'Accrual' };

export default function JournalSuggestionsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => previousMonth(today()));
  const base = `/v1/orgs/${orgId}/journal-suggestions`;
  const q = useQuery({ queryKey: ['journal-suggestions', orgId, month], queryFn: () => api<Result>(`${base}?month=${month}`), enabled: /^\d{4}-\d{2}$/.test(month) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['journal-suggestions', orgId] });
    void qc.invalidateQueries({ queryKey: ['journals', orgId] });
  };
  const accept = useMutation({ mutationFn: (key: string) => api<{ id: string }>(`${base}/accept`, { method: 'POST', body: { month, key } }), onSuccess: refresh });
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const dismiss = useMutation({
    mutationFn: (key: string) => api<Result>(`${base}/dismiss`, { method: 'POST', body: { month, key, reason } }),
    onSuccess: () => {
      setDismissing(null);
      setReason('');
      refresh();
    },
  });
  if (!org) return null;
  const act = can(org.role, 'journals.create');
  const r = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Journal suggestions"
        description="Journals the books suggest for a month: a journal you typed in each of the last three months but not this one, and costs that came every month but not this one, to accrue. Nothing is posted until you check it."
        actions={
          <Field label="Month">{(p) => <Input {...p} type="month" value={month} max={today().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} className="w-44" />}</Field>
        }
      />
      <ErrorAlert title="Could not load the suggestions" error={q.error} />
      <ErrorAlert title="Could not save the draft journal" error={accept.error} />
      <ErrorAlert title="Could not dismiss the suggestion" error={dismiss.error} />
      {accept.data ? (
        <Alert tone="positive" title="Saved as a draft journal">
          Check it and post it from <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${accept.data.id}`}>the journal</Link>.
        </Alert>
      ) : null}
      {r ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Open suggestions" value={String(r.suggestions.length)} tone={r.suggestions.length ? 'warning' : 'positive'} sub={short(r.month)} />
            <Stat label="Missed repeats" value={String(r.suggestions.filter((s) => s.kind === 'REPEAT').length)} tone="accent" />
            <Stat label="Accruals" value={String(r.suggestions.filter((s) => s.kind === 'ACCRUAL').length)} tone="violet" />
            <Stat label="Decided" value={String(r.decisions.length)} sub={`${r.decisions.filter((d) => d.action === 'ACCEPTED').length} accepted`} />
          </div>
          {r.notes.map((n) => <div key={n} className="mb-3"><Alert tone="neutral" title="Note">{n}</Alert></div>)}
          <Card className="mb-4 p-4">
            <CardHeader title="Suggested journals" description="Each one is worked out from the posted journals of the month and the three before it. Accepting saves a draft journal; dismissing keeps it out of this month." />
            {!r.suggestions.length ? <EmptyState title="Nothing to suggest">No journal is missing for {short(r.month)} going by the last three months.</EmptyState> : null}
            <ul className="space-y-3" aria-label="Suggested journals">
              {r.suggestions.map((s) => (
                <li key={s.key} className="rounded-lg border border-border p-3" aria-label={s.title}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={s.kind === 'ACCRUAL' ? 'violet' : 'accent'}>{KIND[s.kind]}</Badge>
                    <span className="font-medium">{s.title}</span>
                    <span className="text-sm text-fg-muted">{date(s.date)}</span>
                    <span className="ml-auto font-medium"><Money value={s.total} currency={c} /></span>
                  </div>
                  <p className="mt-1 text-sm text-fg-muted">{s.reason}</p>
                  <p className="mt-1 text-xs text-fg-faint">
                    {s.history.map((h) => <span key={h.month} className="mr-3">{short(h.month)}: <Money value={h.amount} currency={c} /></span>)}
                    {s.basedOn.length ? <span>Based on {s.basedOn.map((b, i) => <span key={b.id}>{i ? ', ' : ''}<Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${b.id}`}>#{b.entryNumber ?? '—'}</Link></span>)}</span> : null}
                  </p>
                  <Table aria-label={`Lines of ${s.title}`} className="mt-2">
                    <thead><tr><Th>Account</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></tr></thead>
                    <tbody>
                      {s.lines.map((l, i) => (
                        <Tr key={i}>
                          <Td><span className="num text-fg-muted">{l.accountCode}</span> {l.accountName}</Td>
                          <Td numeric>{l.debit ? <Money value={l.debit} currency={c} /> : null}</Td>
                          <Td numeric>{l.credit ? <Money value={l.credit} currency={c} /> : null}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                  {act ? (
                    dismissing === s.key ? (
                      <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); dismiss.mutate(s.key); }}>
                        <Field label="Why dismiss it?">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="w-96" autoFocus />}</Field>
                        <Button type="submit" variant="secondary" size="sm" loading={dismiss.isPending} disabled={reason.trim().length < 3}>Dismiss</Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setDismissing(null)}>Cancel</Button>
                      </form>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" loading={accept.isPending && accept.variables === s.key} onClick={() => accept.mutate(s.key)}>Save as draft journal</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setDismissing(s.key); setReason(''); }}>Dismiss…</Button>
                      </div>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4">
            <CardHeader title="Decisions this month" description="Suggestions accepted or dismissed for this month. Each decision is recorded once." />
            {!r.decisions.length ? <EmptyState title="No decisions yet">Accepted and dismissed suggestions are listed here.</EmptyState> : (
              <Table aria-label="Decisions this month">
                <thead><tr><Th>Suggestion</Th><Th>Decision</Th><Th numeric>Amount</Th><Th>Journal or reason</Th><Th>When</Th></tr></thead>
                <tbody>
                  {r.decisions.map((d) => (
                    <Tr key={d.id}>
                      <Td>{d.title} <span className="text-xs text-fg-faint">{KIND[d.kind]}</span></Td>
                      <Td>{d.action === 'ACCEPTED' ? <Badge tone="positive">Accepted</Badge> : <Badge tone="neutral">Dismissed</Badge>}</Td>
                      <Td numeric><Money value={d.total} currency={c} /></Td>
                      <Td>{d.journal ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${d.journal.id}`}>{d.journal.entryNumber ? `Journal #${d.journal.entryNumber}` : 'Draft journal'}</Link> : d.reason}</Td>
                      <Td className="whitespace-nowrap">{date(d.createdAt.slice(0, 10))}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
