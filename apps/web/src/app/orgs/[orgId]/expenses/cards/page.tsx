'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Status = 'REQUESTED' | 'ACTIVE' | 'FROZEN' | 'CANCELLED';
type TxnStatus = 'UNCODED' | 'CODED' | 'POSTED' | 'EXCLUDED';
interface Acc { id: string; code: string; name: string }
interface Program { id: string; name: string; provider: string; currency: string; account: { id: string; name: string }; status: 'ACTIVE' | 'REVOKED'; prefix: string; createdBy: string; lastDeliveryAt: string | null; transactionsReceived: number }
interface CompanyCard { id: string; reference: string; program: string; currency: string; kind: 'CORPORATE' | 'VIRTUAL'; label: string; holder: { id: string; name: string }; status: Status; last4: string | null; expires: string | null; limit: string | null; spent: string; remaining: string | null; usedPercent: number | null; over: boolean }
interface Overview { currency: string; accounts: Acc[]; liabilityAccounts: Acc[]; members: { id: string; name: string; role: string }[]; canManage: boolean; canPost: boolean; canSetUp: boolean; programs: Program[]; cards: CompanyCard[]; waiting: { uncoded: number; coded: number } }
interface ClaimMatch { claimId: string; claimNumber: string; claimStatus: string; lineNo: number; date: string }
interface Txn { id: string; externalId: string; date: string; amount: string; currency: string; merchant: string; state: 'AUTHORISED' | 'SETTLED'; status: TxnStatus; note: string | null; holder: { name: string }; card: { reference: string; label: string; last4: string | null } | null; account: Acc | null; journalEntryId: string | null; journalEntryNumber: number | null; excludedReason: string | null; claimMatches: ClaimMatch[]; canCode: boolean }

const CARD_STATUS: Record<Status, { label: string; tone: 'neutral' | 'positive' | 'warning' | 'negative' }> = { REQUESTED: { label: 'Waiting for the provider', tone: 'warning' }, ACTIVE: { label: 'Active', tone: 'positive' }, FROZEN: { label: 'Frozen', tone: 'negative' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' } };
const TXN_STATUS: Record<TxnStatus, { label: string; tone: 'neutral' | 'positive' | 'warning' | 'accent' }> = { UNCODED: { label: 'To explain', tone: 'warning' }, CODED: { label: 'Explained', tone: 'accent' }, POSTED: { label: 'Posted', tone: 'positive' }, EXCLUDED: { label: 'Excluded', tone: 'neutral' } };

/**
 * Expenses → Company cards (EXP-011 corporate cards, EXP-012 virtual cards): the organisation's
 * cards with their controls and this month's spending, the spending itself for cardholders to
 * explain and finance to post, and the card programmes that let a provider send it.
 */
export default function CompanyCardsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<TxnStatus | ''>('');
  const overview = useQuery({ queryKey: ['company-cards', orgId], queryFn: () => api<Overview>(`/v1/orgs/${orgId}/company-cards`) });
  const txns = useQuery({ queryKey: ['card-transactions', orgId, filter], queryFn: () => api<Txn[]>(`/v1/orgs/${orgId}/company-cards/transactions${filter ? `?status=${filter}` : ''}`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['company-cards', orgId] }), qc.invalidateQueries({ queryKey: ['card-transactions', orgId] })]);
  if (!org) return null;
  const o = overview.data;
  const finance = !!o && (o.canManage || o.canPost);
  return (
    <>
      <PageHeader
        title="Company cards"
        description="Corporate cards in people's hands and virtual cards made for one use, from any card provider. The provider reads the limits and freezes set here and sends the spending; cardholders say what it was for, and finance posts it to the books. Only the last four digits of a card are kept."
      />
      <ErrorAlert title="Could not load company cards" error={overview.error ?? txns.error} />
      {o && finance && (o.waiting.uncoded || o.waiting.coded) ? (
        <p className="mb-4 text-sm text-fg-muted" data-testid="cards-waiting">
          {o.waiting.uncoded} {o.waiting.uncoded === 1 ? 'transaction is' : 'transactions are'} waiting to be explained and {o.waiting.coded} {o.waiting.coded === 1 ? 'is' : 'are'} ready to post.
        </p>
      ) : null}
      <Card role="region" aria-label="Cards">
        <CardHeader title="Company cards on issue" description={finance ? 'Every card with its holder, monthly limit and spending this calendar month.' : 'The company cards you hold, with this month\'s spending against their limits.'} />
        {o?.cards.length ? (
          <Table aria-label="Company cards">
            <thead><Tr><Th>Card</Th><Th>Holder</Th><Th>Status</Th><Th numeric>Spent this month</Th><Th numeric>Monthly limit</Th>{o.canManage ? <Th>Controls</Th> : null}</Tr></thead>
            <tbody>{o.cards.map((c) => <CardRow key={c.id} orgId={orgId} card={c} canManage={o.canManage} onDone={refresh} />)}</tbody>
          </Table>
        ) : o ? (
          <EmptyState title={finance ? 'No company cards yet' : 'You hold no company cards'}>{o.canManage ? (o.programs.some((p) => p.status === 'ACTIVE') ? 'Add a card below.' : 'Set up a card programme for your provider first, then add cards.') : 'Finance gives out company cards.'}</EmptyState>
        ) : null}
      </Card>

      <Card role="region" aria-label="Card spending" className="mt-4">
        <CardHeader title="Card spending" description="Transactions the provider sent, newest first. Say what each was for; finance posts settled spending to the books, debiting the account and crediting the card account." />
        <div className="flex items-end gap-3 px-4 pb-3">
          <Field label="Show">
            {(p) => (
              <Select {...p} value={filter} onChange={(e) => setFilter(e.target.value as TxnStatus | '')}>
                <option value="">All</option>
                {Object.entries(TXN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
        {txns.data?.length && o ? (
          <Table aria-label="Card transactions">
            <thead><Tr><Th>Date</Th><Th>Card</Th><Th>Merchant</Th><Th numeric>Amount</Th><Th>Status</Th><Th>What it was for</Th></Tr></thead>
            <tbody>{txns.data.map((t) => <TxnRow key={t.id} orgId={orgId} t={t} accounts={o.accounts} canPost={o.canPost} canManage={o.canManage} onDone={refresh} />)}</tbody>
          </Table>
        ) : txns.data ? (
          <EmptyState title="No card spending">{filter ? 'Nothing with this status.' : 'Transactions appear here as the card provider sends them.'}</EmptyState>
        ) : null}
      </Card>

      {o?.canManage ? <AddCard orgId={orgId} o={o} onDone={refresh} /> : null}
      {o && finance ? <Programs orgId={orgId} o={o} onDone={refresh} /> : null}
    </>
  );
}

function CardRow({ orgId, card: c, canManage, onDone }: { orgId: string; card: CompanyCard; canManage: boolean; onDone: () => unknown }) {
  const [limit, setLimit] = useState<string | null>(null);
  const control = useMutation({
    mutationFn: (b: { action: 'FREEZE' | 'UNFREEZE' | 'CANCEL' | 'LIMIT'; monthlyLimit?: string | null }) => api(`/v1/orgs/${orgId}/company-cards/cards/${c.id}/control`, { method: 'POST', body: b }),
    onSuccess: () => {
      setLimit(null);
      void onDone();
    },
  });
  const s = CARD_STATUS[c.status];
  return (
    <Tr data-testid={`card-${c.reference}`}>
      <Td>
        <span className="font-medium">{c.label}</span>
        <span className="block text-xs text-fg-muted">{c.reference} · {c.kind === 'VIRTUAL' ? 'Virtual' : 'Corporate'}{c.last4 ? ` ··${c.last4}` : ''}{c.expires ? ` · expires ${c.expires}` : ''} · {c.program}</span>
      </Td>
      <Td>{c.holder.name}</Td>
      <Td><Badge tone={s.tone}>{s.label}</Badge></Td>
      <Td numeric>
        {money(c.spent, c.currency)}
        {c.usedPercent !== null ? <span className={`block text-xs ${c.over ? 'text-negative' : 'text-fg-muted'}`}>{c.over ? 'Over the limit' : `${c.usedPercent}% used`}</span> : null}
      </Td>
      <Td numeric>{c.limit ? money(c.limit, c.currency) : <span className="text-fg-muted">No limit</span>}</Td>
      {canManage ? (
        <Td>
          {c.status === 'CANCELLED' ? null : limit !== null ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                control.mutate({ action: 'LIMIT', monthlyLimit: limit.trim() || null });
              }}
            >
              <Input aria-label={`New monthly limit for ${c.label}`} value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" placeholder="No limit" className="w-28" />
              <Button type="submit" size="sm" loading={control.isPending}>Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setLimit(null)}>Cancel</Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-1">
              {c.status === 'ACTIVE' ? <Button size="sm" variant="secondary" onClick={() => control.mutate({ action: 'FREEZE' })} disabled={control.isPending}>Freeze</Button> : null}
              {c.status === 'FROZEN' ? <Button size="sm" variant="secondary" onClick={() => control.mutate({ action: 'UNFREEZE' })} disabled={control.isPending}>Unfreeze</Button> : null}
              <Button size="sm" variant="ghost" onClick={() => setLimit(c.limit ?? '')}>Change limit</Button>
              <Button size="sm" variant="ghost" aria-label={`Cancel ${c.label}`} onClick={() => control.mutate({ action: 'CANCEL' })} disabled={control.isPending}>Cancel card</Button>
            </div>
          )}
          <ErrorAlert title="Could not change the card" error={control.error} />
        </Td>
      ) : null}
    </Tr>
  );
}

function TxnRow({ orgId, t, accounts, canPost, canManage, onDone }: { orgId: string; t: Txn; accounts: Acc[]; canPost: boolean; canManage: boolean; onDone: () => unknown }) {
  const [editing, setEditing] = useState(false);
  const [accountId, setAccountId] = useState(t.account?.id ?? '');
  const [note, setNote] = useState(t.note ?? '');
  const [excluding, setExcluding] = useState<string | null>(null);
  const base = `/v1/orgs/${orgId}/company-cards/transactions/${t.id}`;
  const done = () => {
    setEditing(false);
    setExcluding(null);
    void onDone();
  };
  const code = useMutation({ mutationFn: () => api(`${base}/code`, { method: 'POST', body: { accountId, note: note.trim() || null } }), onSuccess: done });
  const post = useMutation({ mutationFn: () => api(`${base}/post`, { method: 'POST', body: {} }), onSuccess: done });
  const exclude = useMutation({ mutationFn: () => api(`${base}/exclude`, { method: 'POST', body: { reason: excluding ?? '' } }), onSuccess: done });
  const s = TXN_STATUS[t.status];
  const refund = t.amount.startsWith('-');
  return (
    <Tr data-testid={`txn-${t.externalId}`}>
      <Td className="whitespace-nowrap">{date(t.date)}</Td>
      <Td>{t.card ? <>{t.card.label}{t.card.last4 ? ` ··${t.card.last4}` : ''}</> : '—'}<span className="block text-xs text-fg-muted">{t.holder.name}</span></Td>
      <Td>
        {t.merchant}
        {t.claimMatches.length ? (
          <span className="mt-1 block text-xs text-negative" role="note">
            Possibly claimed twice: also on{' '}
            {t.claimMatches.map((m, i) => (
              <span key={`${m.claimId}-${m.lineNo}`}>{i ? ', ' : ''}<Link className="underline" href={`/orgs/${orgId}/expenses/${m.claimId}`}>{m.claimNumber}</Link> line {m.lineNo} ({m.claimStatus.toLowerCase()})</span>
            ))}
          </span>
        ) : null}
      </Td>
      <Td numeric>{money(t.amount, t.currency)}{refund ? <span className="block text-xs text-fg-muted">Refund</span> : null}</Td>
      <Td>
        <Badge tone={s.tone}>{s.label}</Badge>
        {t.state === 'AUTHORISED' ? <span className="block text-xs text-fg-muted">Authorised, not settled</span> : null}
        {t.journalEntryId ? <Link className="block text-xs underline" href={`/orgs/${orgId}/journals/${t.journalEntryId}`}>Journal {t.journalEntryNumber ?? ''}</Link> : null}
      </Td>
      <Td>
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              code.mutate();
            }}
          >
            <Select aria-label={`Account for ${t.merchant}`} value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
              <option value="">Choose an account</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </Select>
            <Input aria-label={`Note for ${t.merchant}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="What it was for" />
            <div className="flex gap-1">
              <Button type="submit" size="sm" loading={code.isPending} disabled={!accountId}>Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
            <ErrorAlert title="Could not save" error={code.error} />
          </form>
        ) : excluding !== null ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              exclude.mutate();
            }}
          >
            <Input aria-label={`Why ${t.merchant} stays out of the books`} value={excluding} onChange={(e) => setExcluding(e.target.value)} maxLength={300} placeholder="Why it stays out of the books" required />
            <div className="flex gap-1">
              <Button type="submit" size="sm" loading={exclude.isPending} disabled={excluding.trim().length < 3}>Exclude</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setExcluding(null)}>Cancel</Button>
            </div>
            <ErrorAlert title="Could not exclude" error={exclude.error} />
          </form>
        ) : (
          <>
            {t.account ? <span className="block">{t.account.code} {t.account.name}</span> : null}
            {t.note ? <span className="block text-xs text-fg-muted">{t.note}</span> : null}
            {t.excludedReason ? <span className="block text-xs text-fg-muted">Excluded: {t.excludedReason}</span> : null}
            <div className="mt-1 flex flex-wrap gap-1">
              {t.canCode ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t.status === 'CODED' ? 'Change' : 'Explain'}</Button> : null}
              {canPost && t.status === 'CODED' && t.state === 'SETTLED' ? <Button size="sm" onClick={() => post.mutate()} loading={post.isPending}>Post</Button> : null}
              {canManage && (t.status === 'UNCODED' || t.status === 'CODED') ? <Button size="sm" variant="ghost" onClick={() => setExcluding('')}>Exclude</Button> : null}
            </div>
            <ErrorAlert title="Could not post" error={post.error} />
          </>
        )}
      </Td>
    </Tr>
  );
}

function AddCard({ orgId, o, onDone }: { orgId: string; o: Overview; onDone: () => unknown }) {
  const programs = o.programs.filter((p) => p.status === 'ACTIVE');
  const empty = { programId: '', kind: 'CORPORATE' as 'CORPORATE' | 'VIRTUAL', holderId: '', label: '', monthlyLimit: '', last4: '', expires: '' };
  const [form, setForm] = useState(empty);
  const [made, setMade] = useState<CompanyCard | null>(null);
  const programId = form.programId || programs[0]?.id || '';
  const create = useMutation({
    mutationFn: () =>
      api<CompanyCard>(`/v1/orgs/${orgId}/company-cards/cards`, {
        method: 'POST',
        body: { programId, kind: form.kind, holderId: form.holderId, label: form.label, monthlyLimit: form.monthlyLimit.trim() || null, ...(form.kind === 'CORPORATE' ? { last4: form.last4, expires: form.expires || null } : {}) },
      }),
    onSuccess: (c) => {
      setMade(c);
      setForm(empty);
      void onDone();
    },
  });
  if (!programs.length) return null;
  return (
    <Card role="region" aria-label="Add a company card" className="mt-4">
      <CardHeader title="Add a company card" description="Add a corporate card someone already holds, by its last four digits, or ask the provider for a virtual card; it becomes active when the provider issues it." />
      <form
        className="grid gap-4 p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setMade(null);
          create.mutate();
        }}
      >
        {programs.length > 1 ? (
          <Field label="Programme">
            {(p) => (
              <Select {...p} value={programId} onChange={(e) => setForm({ ...form, programId: e.target.value })}>
                {programs.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.provider})</option>)}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Kind of card">
          {(p) => (
            <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'CORPORATE' | 'VIRTUAL' })}>
              <option value="CORPORATE">Corporate card already issued</option>
              <option value="VIRTUAL">Virtual card from the provider</option>
            </Select>
          )}
        </Field>
        <Field label="Cardholder">
          {(p) => (
            <Select {...p} value={form.holderId} onChange={(e) => setForm({ ...form, holderId: e.target.value })} required>
              <option value="">Choose a person</option>
              {o.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Card name" hint="What it is for, like Travel or Software subscriptions.">
          {(p) => <Input {...p} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={80} required />}
        </Field>
        <Field label="Monthly limit" hint={`In ${o.currency}. Leave empty for no limit.`}>
          {(p) => <Input {...p} value={form.monthlyLimit} onChange={(e) => setForm({ ...form, monthlyLimit: e.target.value })} inputMode="decimal" />}
        </Field>
        {form.kind === 'CORPORATE' ? (
          <>
            <Field label="Last four digits" hint="Never enter the full card number.">
              {(p) => <Input {...p} value={form.last4} onChange={(e) => setForm({ ...form, last4: e.target.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" maxLength={4} required />}
            </Field>
            <Field label="Expires" hint="YYYY-MM, optional.">
              {(p) => <Input {...p} value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} placeholder="2029-12" maxLength={7} />}
            </Field>
          </>
        ) : null}
        <div className="sm:col-span-2">
          <ErrorAlert title="Could not add the card" error={create.error} />
          {made ? <Alert tone="positive" title={made.status === 'REQUESTED' ? `${made.reference} ${made.label} is waiting for the provider to issue it` : `${made.reference} ${made.label} is active`} /> : null}
          <div className="mt-2"><Button type="submit" loading={create.isPending} disabled={!form.holderId || !form.label.trim() || (form.kind === 'CORPORATE' && form.last4.length !== 4)}>{form.kind === 'VIRTUAL' ? 'Ask for the virtual card' : 'Add card'}</Button></div>
        </div>
      </form>
    </Card>
  );
}

function Programs({ orgId, o, onDone }: { orgId: string; o: Overview; onDone: () => unknown }) {
  const [form, setForm] = useState({ name: '', provider: '', liabilityAccountId: '' });
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const accountId = form.liabilityAccountId || o.liabilityAccounts[0]?.id || '';
  const create = useMutation({
    mutationFn: () => api<Program & { token: string }>(`/v1/orgs/${orgId}/company-cards/programs`, { method: 'POST', body: { ...form, liabilityAccountId: accountId } }),
    onSuccess: (p) => {
      setMade({ name: p.name, token: p.token });
      setCopied(false);
      setForm({ name: '', provider: '', liabilityAccountId: '' });
      void onDone();
    },
  });
  const disconnect = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/company-cards/programs/${id}/disconnect`, { method: 'POST', body: {} }), onSuccess: () => void onDone() });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const code = 'font-mono text-xs';
  return (
    <Card role="region" aria-label="Card programmes" className="mt-4">
      <CardHeader title="Card programmes" description="Each card provider's account with the organisation, paid through one liability account. The provider uses the programme's token to read card controls and send spending." />
      {o.programs.length ? (
        <Table aria-label="Card programmes">
          <thead><Tr><Th>Programme</Th><Th>Paid through</Th><Th>Last delivery</Th><Th numeric>Transactions</Th>{o.canSetUp ? <Th /> : null}</Tr></thead>
          <tbody>
            {o.programs.map((p) => (
              <Tr key={p.id}>
                <Td>{p.name}<span className="block text-xs text-fg-muted">{p.provider} · {p.currency} · token t2tc_{p.prefix}…{p.status === 'REVOKED' ? ' · disconnected' : ''}</span></Td>
                <Td>{p.account.name}</Td>
                <Td className="whitespace-nowrap">{p.lastDeliveryAt ? dateTime(p.lastDeliveryAt) : <span className="text-fg-muted">None yet</span>}</Td>
                <Td numeric>{p.transactionsReceived}</Td>
                {o.canSetUp ? <Td>{p.status === 'ACTIVE' ? <Button size="sm" variant="ghost" aria-label={`Disconnect ${p.name}`} onClick={() => disconnect.mutate(p.id)} disabled={disconnect.isPending}>Disconnect</Button> : null}</Td> : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No card programmes yet">{o.canSetUp ? 'Set one up below for your card provider.' : 'An owner or admin sets up card programmes.'}</EmptyState>
      )}
      {made ? (
        <div className="px-4 pb-4">
          <Alert tone="positive" title={`${made.name} is set up`}>
            <div className="space-y-3 text-sm">
              <p>Give this token to the card provider. It is shown only now.</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded bg-surface-raised px-2 py-1 font-mono text-xs" aria-label="Card programme token">{made.token}</code>
                <Button type="button" size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(made.token).then(() => setCopied(true)).catch(() => undefined)}>{copied ? 'Copied' : 'Copy token'}</Button>
              </div>
              <p className="text-fg-muted">
                The provider sends <code className={code}>Authorization: Bearer t2tc_…</code> to <code className={code}>GET {origin}/api/card-feed/cards</code> for the cards and their controls, <code className={code}>POST /api/card-feed/cards/{'{cardId}'}/issued</code> with{' '}
                <code className={code}>{'{"providerRef":"vc_1","last4":"1234","expires":"2029-12"}'}</code> when it issues a virtual card, and <code className={code}>POST /api/card-feed/transactions</code> with{' '}
                <code className={code}>{'{"transactions":[{"id":"tx_1","card":"vc_1","date":"2026-11-20","amount":"1180.00","merchant":"Airline","state":"SETTLED"}]}'}</code>. Amounts are strings in the programme&apos;s currency; negative is a refund. Sending an id again never adds it twice, and a settled transaction replaces its authorisation.
              </p>
            </div>
          </Alert>
        </div>
      ) : null}
      <ErrorAlert title="Could not disconnect" error={disconnect.error} />
      {o.canSetUp ? (
        <form
          className="grid gap-4 border-t border-line p-4 sm:grid-cols-3"
          aria-label="Set up a card programme"
          onSubmit={(e) => {
            e.preventDefault();
            setMade(null);
            create.mutate();
          }}
        >
          <Field label="Programme name">
            {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required />}
          </Field>
          <Field label="Card provider">
            {(p) => <Input {...p} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} maxLength={80} required />}
          </Field>
          <Field label="Paid through">
            {(p) => (
              <Select {...p} value={accountId} onChange={(e) => setForm({ ...form, liabilityAccountId: e.target.value })}>
                {o.liabilityAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </Select>
            )}
          </Field>
          <div className="sm:col-span-3">
            <ErrorAlert title="Could not set up the programme" error={create.error} />
            <Button type="submit" loading={create.isPending} disabled={form.name.trim().length < 2 || form.provider.trim().length < 2 || !accountId}>Set up programme</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
