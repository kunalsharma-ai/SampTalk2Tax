'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { type BankFeed, EXPECT_HOURS, every, FEED_KIND, FeedToken, HealthBadge, OutcomeBadge } from '@/components/banking/bank-feeds';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface BankAccount { id: string; code: string; name: string; subtype: string; isActive: boolean; currency: string }

/** Banking → Bank feeds (BANK-004): connections that send a bank account's transactions as they happen. */
export default function BankFeedsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const feeds = useQuery({ queryKey: ['bank-feeds', orgId], queryFn: () => api<BankFeed[]>(`/v1/orgs/${orgId}/banking/feeds`) });
  const accounts = useQuery({ queryKey: ['bank-accounts', orgId], queryFn: () => api<BankAccount[]>(`/v1/orgs/${orgId}/banking/accounts`) });
  const [form, setForm] = useState({ accountId: '', name: '', kind: 'TRANSACTIONS' as BankFeed['kind'], expectEveryHours: 24 });
  const [made, setMade] = useState<(BankFeed & { token: string }) | null>(null);
  const create = useMutation({
    mutationFn: () => api<BankFeed & { token: string }>(`/v1/orgs/${orgId}/banking/feeds`, { method: 'POST', body: form }),
    onSuccess: (f) => {
      setMade(f);
      setForm({ accountId: '', name: '', kind: 'TRANSACTIONS', expectEveryHours: 24 });
      void qc.invalidateQueries({ queryKey: ['bank-feeds', orgId] });
    },
  });
  if (!org) return null;
  const live = new Set((feeds.data ?? []).filter((f) => f.status !== 'REVOKED').map((f) => f.account.id));
  const free = (accounts.data ?? []).filter((a) => a.subtype === 'BANK' && a.isActive && !live.has(a.id));
  return (
    <>
      <PageHeader
        title="Bank feeds"
        description="Connections that send a bank account's transactions as they happen: a bank's host-to-host channel, an account aggregator partner, a treasury system or a script. Lines arrive unmatched and are reconciled like an imported statement; nothing is ever added twice."
      />
      <ErrorAlert title="Could not load bank feeds" error={feeds.error ?? accounts.error} />
      <Card role="region" aria-label="Bank feeds set up">
        <CardHeader title="Bank feeds set up" description="One live feed per bank account, so the same money is never added by two." />
        {feeds.data?.length ? (
          <Table aria-label="Bank feeds set up">
            <thead><Tr><Th>Feed</Th><Th>Bank account</Th><Th>Health</Th><Th>Last delivery</Th><Th numeric>Lines added</Th></Tr></thead>
            <tbody>
              {feeds.data.map((f) => (
                <Tr key={f.id}>
                  <Td><Link className="underline" href={`/orgs/${orgId}/banking/feeds/${f.id}`}>{f.name}</Link><span className="block text-xs text-fg-muted">{FEED_KIND[f.kind]}, expected {every(f.expectEveryHours)}</span></Td>
                  <Td>{f.account.code} {f.account.name}</Td>
                  <Td><HealthBadge health={f.health} /><span className="block text-xs text-fg-muted">{f.healthMessage}</span></Td>
                  <Td className="whitespace-nowrap">{f.lastDeliveryAt ? <>{dateTime(f.lastDeliveryAt)} {f.lastOutcome ? <OutcomeBadge outcome={f.lastOutcome} /> : null}</> : <span className="text-fg-muted">None yet</span>}</Td>
                  <Td numeric>{f.linesImported}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : feeds.data ? (
          <EmptyState title="No bank feeds yet">Set one up below, or keep importing statement files from each bank account.</EmptyState>
        ) : null}
      </Card>
      {made ? (
        <div className="mt-4">
          <Alert tone="positive" title={`${made.name} is set up for ${made.account.code} ${made.account.name}`}>
            <FeedToken feed={made} />
          </Alert>
        </div>
      ) : null}
      {can(org.role, 'org.manage') ? (
        <Card role="region" aria-label="Set up a feed" className="mt-4">
          <CardHeader title="Set up a feed" description="Owners and admins set up feeds, because the token lets someone add lines to the account." />
          <form
            className="grid gap-4 p-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMade(null);
              create.mutate();
            }}
          >
            <Field label="Bank account">
              {(p) => (
                <Select {...p} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} required>
                  <option value="">Choose an account</option>
                  {free.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name} ({a.currency})</option>)}
                </Select>
              )}
            </Field>
            <Field label="Feed name" hint="Who or what sends it, like HDFC host-to-host.">
              {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required />}
            </Field>
            <Field label="What it sends">
              {(p) => (
                <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as BankFeed['kind'] })}>
                  {Object.entries(FEED_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Expect something" hint="A feed quiet for longer shows as late.">
              {(p) => (
                <Select {...p} value={String(form.expectEveryHours)} onChange={(e) => setForm({ ...form, expectEveryHours: Number(e.target.value) })}>
                  {EXPECT_HOURS.map((h) => <option key={h} value={h}>{every(h)}</option>)}
                </Select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <ErrorAlert title="Could not set up the feed" error={create.error} />
              <Button type="submit" loading={create.isPending} disabled={!form.accountId || form.name.trim().length < 2}>Set up feed</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  );
}
