'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { type BankFeed, type BankFeedDelivery, EXPECT_HOURS, every, FEED_KIND, FeedToken, HealthBadge, OutcomeBadge, SenderInstructions } from '@/components/banking/bank-feeds';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Feed = BankFeed & { deliveries: BankFeedDelivery[] };

/** One bank feed (BANK-004): its state, how the sender uses it, and every delivery with what was refused and why. */
export default function BankFeedPage() {
  const { org, orgId } = useOrg();
  const { feedId } = useParams<{ feedId: string }>();
  const qc = useQueryClient();
  const key = ['bank-feed', orgId, feedId];
  const url = `/v1/orgs/${orgId}/banking/feeds/${feedId}`;
  const q = useQuery({ queryKey: key, queryFn: () => api<Feed>(url) });
  const [token, setToken] = useState<(Feed & { token: string }) | null>(null);
  const [edit, setEdit] = useState<{ name: string; expectEveryHours: number } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const done = (f: Feed) => {
    qc.setQueryData(key, f);
    void qc.invalidateQueries({ queryKey: ['bank-feeds', orgId] });
  };
  const act = useMutation({
    mutationFn: (what: 'pause' | 'resume' | 'rotate-token' | 'disconnect') => api<Feed & { token?: string }>(`${url}/${what}`, { method: 'POST' }),
    onSuccess: (f) => {
      done(f);
      setToken(f.token ? (f as Feed & { token: string }) : null);
      setConfirmOff(false);
    },
  });
  const save = useMutation({ mutationFn: () => api<Feed>(url, { method: 'PUT', body: edit! }), onSuccess: (f) => { done(f); setEdit(null); } });
  if (!org) return null;
  const f = q.data;
  const manage = can(org.role, 'banking.manage');
  const admin = can(org.role, 'org.manage');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <>
      <PageHeader
        title={f ? f.name : 'Bank feed'}
        description={f ? `${FEED_KIND[f.kind]} for ${f.account.code} ${f.account.name}, expected ${every(f.expectEveryHours)}. Set up by ${f.createdBy ?? 'a former member'}.` : undefined}
        actions={<Link className="text-sm underline" href={`/orgs/${orgId}/banking/feeds`}>All feeds</Link>}
      />
      <ErrorAlert title="Could not load the feed" error={q.error ?? act.error ?? save.error} />
      {f ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Stat label="Health" value={<HealthBadge health={f.health} />} sub={f.healthMessage} />
            <Stat label="Last delivery" value={f.lastDeliveryAt ? dateTime(f.lastDeliveryAt) : 'None yet'} />
            <Stat label="Deliveries" value={f.deliveryCount} />
            <Stat label="Lines added" value={f.linesImported} sub={<Link className="underline" href={`/orgs/${orgId}/banking/${f.account.id}`}>Reconcile them</Link>} />
          </div>
          {token ? (
            <div className="mb-4">
              <Alert tone="positive" title="New token made; the old one has stopped working">
                <FeedToken feed={token} />
              </Alert>
            </div>
          ) : null}
          <Card role="region" aria-label="Feed connection" className="mb-4">
            <CardHeader title="Feed connection" description={`Token starting t2tf_${f.prefix}, issued ${dateTime(f.tokenIssuedAt)}.`} />
            <div className="space-y-3 p-4 text-sm">
              {f.status === 'REVOKED' ? (
                <p>Disconnected by {f.revokedBy} on {dateTime(f.revokedAt!)}. Its token no longer works; the lines it added stay on the account. The account can have a new feed.</p>
              ) : (
                <>
                  <SenderInstructions kind={f.kind} origin={origin} />
                  {edit ? (
                    <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                      <Field label="Feed name">{(p) => <Input {...p} value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
                      <Field label="Expect something">
                        {(p) => (
                          <Select {...p} value={String(edit.expectEveryHours)} onChange={(e) => setEdit({ ...edit, expectEveryHours: Number(e.target.value) })}>
                            {EXPECT_HOURS.map((h) => <option key={h} value={h}>{every(h)}</option>)}
                          </Select>
                        )}
                      </Field>
                      <div className="flex items-end gap-2">
                        <Button type="submit" loading={save.isPending}>Save</Button>
                        <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {manage ? <Button type="button" variant="secondary" onClick={() => setEdit({ name: f.name, expectEveryHours: f.expectEveryHours })}>Change</Button> : null}
                      {manage && f.status === 'ACTIVE' ? <Button type="button" variant="secondary" loading={act.isPending && act.variables === 'pause'} onClick={() => act.mutate('pause')}>Pause feed</Button> : null}
                      {manage && f.status === 'PAUSED' ? <Button type="button" loading={act.isPending && act.variables === 'resume'} onClick={() => act.mutate('resume')}>Resume feed</Button> : null}
                      {admin ? <Button type="button" variant="secondary" loading={act.isPending && act.variables === 'rotate-token'} onClick={() => act.mutate('rotate-token')}>Replace token</Button> : null}
                      {admin && !confirmOff ? <Button type="button" variant="danger" onClick={() => setConfirmOff(true)}>Disconnect</Button> : null}
                      {admin && confirmOff ? (
                        <span className="flex items-center gap-2">
                          <span>Disconnect for good? The token stops working.</span>
                          <Button type="button" variant="danger" loading={act.isPending && act.variables === 'disconnect'} onClick={() => act.mutate('disconnect')}>Yes, disconnect</Button>
                          <Button type="button" variant="ghost" onClick={() => setConfirmOff(false)}>Keep it</Button>
                        </span>
                      ) : null}
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
          <Card role="region" aria-label="Feed deliveries">
            <CardHeader title="Feed deliveries" description="The latest 50, newest first. Each says what came in, what was added, what was already on the account and what was refused." />
            {f.deliveries.length ? (
              <Table aria-label="Feed deliveries">
                <thead><Tr><Th>Received</Th><Th>Outcome</Th><Th numeric>Sent</Th><Th numeric>Added</Th><Th numeric>Already there</Th><Th>Refused</Th></Tr></thead>
                <tbody>
                  {f.deliveries.map((d) => (
                    <Tr key={d.id}>
                      <Td className="whitespace-nowrap">{dateTime(d.receivedAt)}{d.fileName ? <span className="block text-xs text-fg-muted">{d.fileName}</span> : null}</Td>
                      <Td><OutcomeBadge outcome={d.outcome} /></Td>
                      <Td numeric>{d.received}</Td>
                      <Td numeric>{d.imported}</Td>
                      <Td numeric>{d.duplicates}</Td>
                      <Td>
                        {d.error ? <span className="text-negative">{d.error}</span> : d.rejections.length ? (
                          <ul className="space-y-1 text-xs">
                            {d.rejections.map((r) => <li key={`${r.position}-${r.id}`}><span className="font-medium">{r.id ? `${r.id} (line ${r.position})` : `Line ${r.position}`}</span>: {r.reasons.join('; ')}</li>)}
                            {d.rejected > d.rejections.length ? <li>and {d.rejected - d.rejections.length} more</li> : null}
                          </ul>
                        ) : <span className="text-fg-muted">None</span>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing received yet">Once the sender posts with the token, each delivery shows here.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
