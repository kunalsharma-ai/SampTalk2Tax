'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Replay {
  asOf: string;
  through: string;
  summary: { accounts: number; changedAccounts: number; recordedBalances: boolean; currentBalances: boolean; netChange: string; entriesSince: number };
  accounts: { accountId: string; code: string; name: string; recorded: string; current: string; change: string }[];
  entriesSince: { id: string; entryNumber: number | null; date: string; postedAt: string; postedBy: string | null; source: string; memo: string | null; amount: string; reverses: { id: string; entryNumber: number | null } | null; accounts: string[] }[];
  moreEntries: boolean;
}

/** A local date and time for a datetime-local input, a day ago. */
function dayAgo(): string {
  const d = new Date(Date.now() - 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Financial transaction replay (AUDIT-017): the books as recorded at a past moment, beside the books now. */
export default function LedgerReplayPage() {
  const { org, orgId } = useOrg();
  const [form, setForm] = useState({ asOf: dayAgo(), through: today() });
  const [asked, setAsked] = useState<{ asOf: string; through: string } | null>(null);
  const q = useQuery({
    queryKey: ['ledger-replay', orgId, asked],
    queryFn: () => api<Replay>(`/v1/orgs/${orgId}/ledger-replay?asOf=${encodeURIComponent(asked!.asOf)}&through=${asked!.through}`),
    enabled: !!asked,
  });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = q.data;
  const changed = r ? r.accounts.filter((a) => Number(a.change) !== 0) : [];
  return (
    <>
      <PageHeader title="Ledger replay" description="See the books exactly as they were recorded at a past moment, beside the books now for the same dates, with every entry posted since that explains the difference. Nothing here changes the books." />
      <Card className="mb-4">
        <CardHeader title="Replay the books" description="Posted entries are never changed, so replaying everything posted by that moment shows what anyone could have seen then." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked({ asOf: new Date(form.asOf).toISOString(), through: form.through });
          }}
        >
          <Field label="As recorded at" hint="Your local time">{(p) => <Input {...p} type="datetime-local" className="w-56" value={form.asOf} onChange={(e) => setForm({ ...form, asOf: e.target.value })} />}</Field>
          <Field label="Entries dated up to">{(p) => <Input {...p} type="date" className="w-44" value={form.through} onChange={(e) => setForm({ ...form, through: e.target.value })} />}</Field>
          <Button type="submit" size="sm" disabled={!form.asOf || !form.through} loading={q.isFetching}>Replay</Button>
        </form>
        <div className="px-4 pb-4"><ErrorAlert title="The books could not be replayed" error={q.error} /></div>
      </Card>
      {r ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-4">
            <Stat label="Accounts changed" value={`${r.summary.changedAccounts} of ${r.summary.accounts}`} tone={r.summary.changedAccounts ? 'warning' : 'positive'} />
            <Stat label="Entries posted since" value={r.summary.entriesSince} tone={r.summary.entriesSince ? 'warning' : 'positive'} />
            <Stat label="Net change" value={money(r.summary.netChange, cur)} sub="Half the sum of every account's change" />
            <Stat label="Both sides balance" value={r.summary.recordedBalances && r.summary.currentBalances ? 'Yes' : 'No'} tone={r.summary.recordedBalances && r.summary.currentBalances ? 'positive' : 'negative'} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Balances then and now" description={`Debits minus credits for entries dated up to ${date(r.through)}: as recorded at ${dateTime(r.asOf)}, and now. Changed accounts first.`} />
            {!r.accounts.length ? (
              <EmptyState title="Nothing posted">No posted entries are dated up to that day.</EmptyState>
            ) : (
              <Table aria-label="Balances then and now">
                <thead><Tr><Th>Account</Th><Th numeric>As recorded</Th><Th numeric>Now</Th><Th numeric>Change</Th></Tr></thead>
                <tbody>
                  {r.accounts.map((a) => (
                    <Tr key={a.accountId}>
                      <Td><span className="font-mono text-xs">{a.code}</span> {a.name}</Td>
                      <Td numeric>{money(a.recorded, cur)}</Td>
                      <Td numeric>{money(a.current, cur)}</Td>
                      <Td numeric>{Number(a.change) === 0 ? <span className="text-fg-muted">No change</span> : <Badge tone="warning">{money(a.change, cur)}</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Entries posted since" description={changed.length ? 'Entries posted after that moment and dated on or before the day: late postings, reversals and corrections. Oldest first.' : 'Nothing was posted for those dates after that moment.'} />
            {r.entriesSince.length ? (
              <Table aria-label="Entries posted since">
                <thead><Tr><Th>Journal</Th><Th>Dated</Th><Th>Posted</Th><Th>Memo</Th><Th>Accounts</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {r.entriesSince.map((e) => (
                    <Tr key={e.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>Journal {e.entryNumber}</Link>{e.reverses ? <div className="text-xs text-fg-muted">Reverses journal {e.reverses.entryNumber}</div> : null}</Td>
                      <Td className="whitespace-nowrap">{date(e.date)}</Td>
                      <Td className="whitespace-nowrap text-xs">{dateTime(e.postedAt)}{e.postedBy ? <div className="text-fg-muted">{e.postedBy}</div> : null}</Td>
                      <Td className="text-sm">{e.memo ?? '—'}</Td>
                      <Td className="font-mono text-xs">{e.accounts.join(', ')}</Td>
                      <Td numeric>{money(e.amount, cur)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {r.moreEntries ? <p className="p-4 text-sm text-fg-muted">Showing the first 200 of {r.summary.entriesSince} entries.</p> : null}
          </Card>
        </>
      ) : null}
    </>
  );
}
