'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AttachmentsPanel } from '@/components/attachments';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { PURCHASES, SALES } from '@/lib/ledgers';
import { useAccounts, useContacts, useOrg } from '@/lib/org';
import { can, type BankAccountSummary, type DocumentSummary, type LedgerCandidate, type LedgerLink, type StatementLine } from '@/lib/types';
import { useBankAccounts } from './accounts-page';

type View = 'UNMATCHED' | 'MATCHED' | 'EXCLUDED' | 'ALL';
const VIEWS: { v: View; label: string }[] = [
  { v: 'UNMATCHED', label: 'To review' },
  { v: 'MATCHED', label: 'Matched' },
  { v: 'EXCLUDED', label: 'Excluded' },
  { v: 'ALL', label: 'All' },
];

export function BankAccountPage() {
  const { org, orgId } = useOrg();
  const { accountId } = useParams<{ accountId: string }>();
  const accounts = useBankAccounts();
  const account = accounts.data?.find((a) => a.id === accountId);
  const [view, setView] = useState<View>('UNMATCHED');
  const [active, setActive] = useState<StatementLine | null>(null);
  const [filesFor, setFilesFor] = useState<StatementLine | null>(null);
  const [showLearned, setShowLearned] = useState(false);
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/banking`;
  const lines = useQuery({
    queryKey: ['bank-lines', orgId, accountId, view],
    queryFn: () => api<{ total: number; lines: StatementLine[] }>(`${base}/accounts/${accountId}/lines?limit=500${view === 'ALL' ? '' : `&status=${view}`}`),
  });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['bank-lines', orgId, accountId] }), qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] })]);
  const autoMatch = useMutation({ mutationFn: () => api<{ matched: number }>(`${base}/accounts/${accountId}/auto-match`, { method: 'POST' }), onSuccess: refresh });
  const quickMatch = useMutation({
    mutationFn: (l: StatementLine) => api(`${base}/lines/${l.id}/match`, { method: 'POST', body: { journalLineIds: [l.suggestion!.journalLineId] } }),
    onSuccess: refresh,
  });
  const unmatch = useMutation({ mutationFn: (l: StatementLine) => api(`${base}/lines/${l.id}/unmatch`, { method: 'POST', body: {} }), onSuccess: refresh });
  const include = useMutation({ mutationFn: (l: StatementLine) => api(`${base}/lines/${l.id}/include`, { method: 'POST' }), onSuccess: refresh });
  if (!org) return null;
  const c = account?.currency ?? org.functionalCurrency;
  const foreign = c !== org.functionalCurrency;
  const manage = can(org.role, 'banking.manage');
  const uniqueSuggestions = (lines.data?.lines ?? []).filter((l) => l.suggestion?.unique).length;
  const error = autoMatch.error ?? quickMatch.error ?? unmatch.error ?? include.error;
  return (
    <>
      <PageHeader
        title={account ? `${account.code} · ${account.name}` : 'Bank account'}
        description={
          account ? (
            <span>
              Balance in the books <Money value={account.ledgerBalance} currency={c} signed />
              {foreign ? <> (<Money value={account.functionalBalance} currency={org.functionalCurrency} signed /> in the accounts)</> : null}
              {account.lastReconciled ? <> · reconciled to {date(account.lastReconciled.date)}</> : <> · not reconciled yet</>}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {account && can(org.role, 'accounts.manage') ? <CurrencyButton account={account} /> : null}
            {manage ? <Link href={`/orgs/${orgId}/banking/${accountId}/import`}><Button variant="secondary">Import statement</Button></Link> : null}
            <Link href={`/orgs/${orgId}/banking/${accountId}/ai`}><Button variant="secondary">AI suggestions</Button></Link>
            <Button variant="secondary" onClick={() => setShowLearned(true)}>What matching learned</Button>
            <Link href={`/orgs/${orgId}/banking/${accountId}/reconcile`}><Button variant="secondary">Reconcile</Button></Link>
            {manage && view === 'UNMATCHED' ? (
              <Button disabled={!uniqueSuggestions} loading={autoMatch.isPending} onClick={() => autoMatch.mutate()}>
                Match {uniqueSuggestions || ''} suggested
              </Button>
            ) : null}
          </div>
        }
      />
      {autoMatch.data ? <div className="mb-4"><Alert tone="positive" title={`Matched ${autoMatch.data.matched} line${autoMatch.data.matched === 1 ? '' : 's'}`}>Only lines with exactly one same-amount ledger line within 14 days are matched automatically. Check the rest below.</Alert></div> : null}
      {error ? <div className="mb-4"><Alert title="Could not update">{error.message}</Alert></div> : null}
      <div role="tablist" aria-label="Statement lines" className="mb-3 flex flex-wrap gap-1">
        {VIEWS.map((t) => (
          <button key={t.v} role="tab" aria-selected={view === t.v} onClick={() => setView(t.v)} className={`rounded-md px-3 py-1.5 text-sm ${view === t.v ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg'}`}>
            {t.label}{t.v === 'UNMATCHED' && account?.unmatchedLines ? ` (${account.unmatchedLines})` : ''}
          </button>
        ))}
      </div>
      {lines.error ? <Alert title="Could not load">{(lines.error as Error).message}</Alert> : null}
      <Card>
        {lines.data && lines.data.lines.length === 0 ? (
          <EmptyState
            title={view === 'UNMATCHED' ? (account?.statementLines ? 'Everything is matched' : 'No statement lines yet') : 'Nothing here'}
            action={manage && !account?.statementLines ? <Link href={`/orgs/${orgId}/banking/${accountId}/import`}><Button>Import a statement</Button></Link> : undefined}
          >
            {account?.statementLines ? undefined : 'Download a CSV statement from your bank and import it.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Statement line</Th>
                <Th numeric>Money in</Th>
                <Th numeric>Money out</Th>
                <Th>In the books</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {(lines.data?.lines ?? []).map((l) => {
                const inflow = !l.amount.startsWith('-');
                return (
                  <Tr key={l.id}>
                    <Td className="whitespace-nowrap align-top">{date(l.date)}</Td>
                    <Td className="align-top">
                      <p>{l.description}</p>
                      {l.reference ? <p className="text-xs text-fg-muted">Ref {l.reference}</p> : null}
                    </Td>
                    <Td numeric className="align-top">{inflow ? <Money value={l.amount} currency={c} /> : null}</Td>
                    <Td numeric className="align-top">{!inflow ? <Money value={l.amount.slice(1)} currency={c} /> : null}</Td>
                    <Td className="align-top">
                      {l.status === 'MATCHED' ? (
                        <div className="flex flex-col gap-1">
                          {l.matches.map((m) => <LinkLine key={m.id} m={m} orgId={orgId} />)}
                          <span>{l.reconciled ? <Badge tone="positive">Reconciled</Badge> : <Badge tone="accent">{m0(l)}</Badge>}</span>
                        </div>
                      ) : l.status === 'EXCLUDED' ? (
                        <div><Badge>Excluded</Badge> <span className="text-xs text-fg-muted">{l.excludedReason}</span></div>
                      ) : l.suggestion ? (
                        <div className="rounded-md border border-accent/30 bg-accent/5 p-2 text-sm">
                          <p className="text-xs font-medium text-accent">Suggested match</p>
                          <LinkLine m={l.suggestion} orgId={orgId} />
                          <p className="text-xs text-fg-muted">{l.suggestion.reasons.join(' · ')}</p>
                        </div>
                      ) : (
                        <span className="text-sm text-fg-faint">Not in the books yet</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right align-top">
                      <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setFilesFor(l)}>
                        {l.attachments ? `Files (${l.attachments})` : 'Files'}
                      </Button>
                      {manage && !l.reconciled ? (
                        l.status === 'UNMATCHED' ? (
                          <div className="flex justify-end gap-2">
                            {l.suggestion ? <Button size="sm" onClick={() => quickMatch.mutate(l)} loading={quickMatch.isPending && quickMatch.variables?.id === l.id}>Match</Button> : null}
                            <Button size="sm" variant={l.suggestion ? 'ghost' : 'secondary'} onClick={() => setActive(l)}>{l.suggestion ? 'Other…' : 'Resolve…'}</Button>
                          </div>
                        ) : l.status === 'MATCHED' ? (
                          <Button size="sm" variant="ghost" onClick={() => confirm(unmatchPrompt(l)) && unmatch.mutate(l)}>Unmatch</Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => include.mutate(l)}>Include again</Button>
                        )
                      ) : null}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {active ? <ResolveDialog line={active} onClose={() => setActive(null)} onDone={async () => { setActive(null); await refresh(); }} /> : null}
      {showLearned ? <LearnedDialog base={`${base}/accounts/${accountId}`} onClose={() => setShowLearned(false)} /> : null}
      {filesFor ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setFilesFor(null)}
          title={`Files · ${filesFor.description}`}
          description={`${date(filesFor.date)} · ${money(new D(filesFor.amount).abs().toFixed(2), c)} ${filesFor.amount.startsWith('-') ? 'out' : 'in'}${filesFor.reference ? ` · Ref ${filesFor.reference}` : ''}`}
        >
          <AttachmentsPanel
            entityType="BANK_STATEMENT_LINE"
            entityId={filesFor.id}
            canManage={manage}
            description="Bank advices, receipts or letters behind this line. PDF, PNG, JPEG or WebP up to 5 MB each."
            onChanged={refresh}
          />
        </Dialog>
      ) : null}
    </>
  );
}

const m0 = (l: StatementLine) => (l.matches.some((m) => m.origin === 'CREATED_ENTRY') ? 'Booked from bank' : l.matches.some((m) => m.origin === 'CREATED_PAYMENT') ? 'Recorded from bank' : 'Matched');
const unmatchPrompt = (l: StatementLine) =>
  l.matches.some((m) => m.origin === 'CREATED_ENTRY')
    ? 'Unmatch this line? The entry created from it will be reversed.'
    : l.matches.some((m) => m.origin === 'CREATED_PAYMENT')
      ? 'Unmatch this line? The receipt or payment stays in the books; void it from its own screen if it was wrong.'
      : 'Unmatch this line? The ledger entry stays as it is.';

interface MatchPattern {
  counterparty: string;
  label: string;
  words: string[];
  kept: number;
  undone: number;
}

/** What suggestions on this account learned from past matches (BANK-017). */
function LearnedDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['bank-match-patterns', base], queryFn: () => api<{ decisions: number; patterns: MatchPattern[] }>(`${base}/match-patterns`) });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="What matching learned"
      description="Each time you match a line, suggestions remember who it was with. A similar line later is suggested with the same contact or account first; a match you undo counts against it."
    >
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {q.data && q.data.patterns.length === 0 ? <p className="text-sm text-fg-muted">Nothing learned yet. Match a few lines and their names will show here.</p> : null}
      {q.data && q.data.patterns.length ? (
        <Table aria-label="Learned matches">
          <thead>
            <tr>
              <Th>Lines that mention</Th>
              <Th>Matched to</Th>
              <Th numeric>Kept</Th>
              <Th numeric>Undone</Th>
            </tr>
          </thead>
          <tbody>
            {q.data.patterns.map((p) => (
              <Tr key={p.counterparty}>
                <Td>{p.words.join(', ')}</Td>
                <Td>{p.label}</Td>
                <Td numeric>{p.kept}</Td>
                <Td numeric>{p.undone}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Dialog>
  );
}

function LinkLine({ m, orgId }: { m: LedgerLink; orgId: string }) {
  const href = m.payment
    ? `/orgs/${orgId}/${m.payment.kind === 'RECEIPT' ? 'sales/receipts' : 'purchases/payments'}/${m.payment.id}`
    : `/orgs/${orgId}/journals/${m.entryId}`;
  return (
    <p className="text-sm">
      <Link className="text-accent hover:underline" href={href}>{m.payment ? m.payment.number : m.entryNumber}</Link>
      <span className="text-fg-muted"> · {date(m.date)} · {m.payment ? m.payment.contactName : m.memo ?? m.reference ?? ''}</span>
    </p>
  );
}

type Mode = 'match' | 'payment' | 'entry' | 'exclude';

/** Keeps the account in another currency (BANK-012): only before statements or other-currency postings depend on it. */
function CurrencyButton({ account }: { account: BankAccountSummary }) {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState(account.currency);
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/banking/accounts/${account.id}/currency`, { method: 'PUT', body: { currency: currency.trim().toUpperCase() || null } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] });
      setOpen(false);
    },
  });
  if (!org) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => { setCurrency(account.currency); save.reset(); setOpen(true); }}>Currency: {account.currency}</Button>
      <Dialog open={open} onOpenChange={setOpen} title={`Currency of ${account.code} · ${account.name}`} description={`For an account the bank keeps in another currency, such as a USD account. Its statements are imported, matched and reconciled in that currency, every posting to it must be in it, and the books carry it in ${org.functionalCurrency} at each entry's rate.`}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Account currency" hint={`Three letters, such as USD. ${org.functionalCurrency} is the organisation's own. It can change only before statements are imported or postings in another currency are made.`}>{(p) => <Input {...p} className="num uppercase" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}</Field>
          {save.error ? <Alert title="Not changed">{save.error.message}</Alert> : null}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={save.isPending} disabled={!/^[A-Za-z]{3}$/.test(currency)}>Save currency</Button></div>
        </form>
      </Dialog>
    </>
  );
}

function ResolveDialog({ line, onClose, onDone }: { line: StatementLine; onClose: () => void; onDone: () => Promise<void> }) {
  const { org } = useOrg();
  const inflow = !line.amount.startsWith('-');
  const l = inflow ? SALES : PURCHASES;
  const [mode, setMode] = useState<Mode>('match');
  const modes: { m: Mode; label: string; show: boolean }[] = [
    { m: 'match', label: 'Find in the books', show: true },
    { m: 'payment', label: inflow ? 'Customer receipt' : 'Vendor payment', show: can(org?.role, l.managePermission) },
    { m: 'entry', label: inflow ? 'Other money in' : 'Other money out', show: can(org?.role, 'journals.post') },
    { m: 'exclude', label: 'Exclude', show: true },
  ];
  const c = line.currency ?? org?.functionalCurrency ?? 'INR';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${inflow ? 'Money in' : 'Money out'} · ${money(new D(line.amount).abs().toFixed(2), c)}`} description={`${date(line.date)} · ${line.description}${line.reference ? ` · Ref ${line.reference}` : ''}`}>
      <div role="tablist" aria-label="How to resolve" className="mb-4 flex flex-wrap gap-1">
        {modes.filter((x) => x.show).map((x) => (
          <button key={x.m} role="tab" aria-selected={mode === x.m} onClick={() => setMode(x.m)} className={`rounded-md px-3 py-1.5 text-sm ${mode === x.m ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg'}`}>{x.label}</button>
        ))}
      </div>
      {mode === 'match' ? <MatchForm line={line} currency={c} onDone={onDone} /> : null}
      {mode === 'payment' ? <PaymentForm line={line} currency={c} onDone={onDone} /> : null}
      {mode === 'entry' ? <EntryForm line={line} onDone={onDone} /> : null}
      {mode === 'exclude' ? <ExcludeForm line={line} onDone={onDone} /> : null}
    </Dialog>
  );
}

function MatchForm({ line, currency, onDone }: { line: StatementLine; currency: string; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const cands = useQuery({
    queryKey: ['bank-candidates', orgId, line.id, search],
    queryFn: () => api<LedgerCandidate[]>(`/v1/orgs/${orgId}/banking/lines/${line.id}/candidates${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  });
  const total = (cands.data ?? []).filter((x) => picked.includes(x.journalLineId)).reduce((s, x) => s.plus(x.amount), new D(0));
  const match = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/banking/lines/${line.id}/match`, { method: 'POST', body: { journalLineIds: picked } }), onSuccess: onDone });
  const equal = total.eq(line.amount);
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); match.mutate(); }}>
      {match.error ? <Alert title="Could not match">{match.error.message}</Alert> : null}
      <Field label="Search memo or reference">{(p) => <Input {...p} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. INV-000012 or a name" />}</Field>
      <p className="text-xs text-fg-muted">Unmatched entries on this account within 90 days, closest amount first. Pick one or more that add up to the statement line.</p>
      <div className="max-h-72 overflow-y-auto rounded-md border border-line">
        {cands.data && cands.data.length === 0 ? <p className="p-3 text-sm text-fg-muted">Nothing unmatched on this account in that window.</p> : null}
        {(cands.data ?? []).map((x) => (
          <label key={x.journalLineId} className="flex cursor-pointer items-start gap-3 border-b border-line p-2 text-sm last:border-0 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-1 accent-[var(--t2t-accent)]"
              aria-label={`Select ${x.entryNumber} ${x.memo ?? ''}`}
              checked={picked.includes(x.journalLineId)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, x.journalLineId] : p.filter((id) => id !== x.journalLineId)))}
            />
            <span className="flex-1">
              <span className="num">{x.entryNumber}</span> · {date(x.date)}
              <span className="block text-xs text-fg-muted">{x.memo ?? x.description ?? x.reference ?? ''}</span>
            </span>
            <Money value={x.amount} currency={currency} signed />
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className={equal ? 'text-positive' : 'text-fg-muted'}>Selected <Money value={total.toFixed(2)} currency={currency} /> of <Money value={line.amount} currency={currency} /></span>
        <Button type="submit" disabled={!equal} loading={match.isPending}>Match</Button>
      </div>
    </form>
  );
}

function PaymentForm({ line, currency, onDone }: { line: StatementLine; currency: string; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const inflow = !line.amount.startsWith('-');
  const l = inflow ? SALES : PURCHASES;
  const contacts = useContacts(l.contactRole);
  const [contactId, setContactId] = useState('');
  const amount = new D(line.amount).abs();
  const open = useQuery({
    enabled: !!contactId,
    queryKey: ['open-docs', orgId, l.api, contactId],
    queryFn: () => api<{ items: DocumentSummary[] }>(`/v1/orgs/${orgId}/${l.api}/documents?view=open&kind=${l.charge.kind}&contactId=${contactId}&limit=200`),
  });
  const docs = useMemo(() => [...(open.data?.items ?? [])].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)), [open.data]);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  useEffect(() => {
    // Oldest first, up to the amount of the statement line.
    let left = amount;
    const next: Record<string, string> = {};
    for (const d of docs) {
      const take = D.min(left, d.amountDue);
      if (take.lte(0)) break;
      next[d.id] = take.toFixed(2);
      left = left.minus(take);
    }
    setAlloc(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);
  const allocated = Object.values(alloc).reduce((s, v) => (v ? s.plus(v) : s), new D(0));
  const save = useMutation({
    mutationFn: () =>
      api(`/v1/orgs/${orgId}/banking/lines/${line.id}/record-payment`, {
        method: 'POST',
        body: { contactId, allocations: Object.entries(alloc).filter(([, v]) => v && new D(v).gt(0)).map(([documentId, a]) => ({ documentId, amount: a })) },
      }),
    onSuccess: onDone,
  });
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {save.error ? <Alert title="Could not record">{save.error.message}</Alert> : null}
      <Field label={l.contact}>
        {(p) => (
          <Select {...p} required value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">Choose a {l.contact.toLowerCase()}</option>
            {(contacts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        )}
      </Field>
      {contactId && docs.length === 0 && open.data ? <p className="text-sm text-fg-muted">No open {l.charge.plural.toLowerCase()}. The whole amount stays as a credit for this {l.contact.toLowerCase()}.</p> : null}
      {docs.map((d) => (
        <div key={d.id} className="flex items-center gap-3 text-sm">
          <span className="flex-1"><span className="num">{d.number}</span> · due {date(d.dueDate)} · <Money value={d.amountDue} currency={currency} /> due</span>
          <Input aria-label={`Apply to ${d.number}`} className="w-32 text-right" inputMode="decimal" value={alloc[d.id] ?? ''} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setAlloc({ ...alloc, [d.id]: e.target.value })} />
        </div>
      ))}
      <p className="text-xs text-fg-muted">
        Records a {l.payment.label.toLowerCase()} of <Money value={amount.toFixed(2)} currency={currency} /> dated {date(line.date)} and matches it to this line.
        {allocated.lt(amount) && contactId ? <> <Money value={amount.minus(allocated).toFixed(2)} currency={currency} /> stays unapplied.</> : null}
      </p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!contactId || allocated.gt(amount)} loading={save.isPending}>Record {l.payment.label.toLowerCase()}</Button>
      </div>
    </form>
  );
}

function EntryForm({ line, onDone }: { line: StatementLine; onDone: () => Promise<void> }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const [accountId, setAccountId] = useState('');
  const [description, setDescription] = useState(line.description);
  const control = new Set([org?.arAccountId, org?.apAccountId, org?.claimsAccountId, line.accountId]);
  const options = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id));
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/banking/lines/${line.id}/create-entry`, { method: 'POST', body: { accountId, description } }), onSuccess: onDone });
  const inflow = !line.amount.startsWith('-');
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {save.error ? <Alert title="Could not post">{save.error.message}</Alert> : null}
      <Field label="Account" hint={inflow ? 'Where the money came from, e.g. Other Income or a loan.' : 'What the money was spent on, e.g. Bank Charges or Rent.'}>
        {(p) => (
          <Select {...p} required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose an account</option>
            {options.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Description">{(p) => <Input {...p} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <p className="text-xs text-fg-muted">Posts a journal dated {date(line.date)} and matches it to this line. Customer and vendor money goes through the receipt or payment tab instead, so it reaches the right invoice or bill.</p>
      <div className="flex justify-end"><Button type="submit" disabled={!accountId} loading={save.isPending}>Post and match</Button></div>
    </form>
  );
}

function ExcludeForm({ line, onDone }: { line: StatementLine; onDone: () => Promise<void> }) {
  const { orgId } = useOrg();
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/banking/lines/${line.id}/exclude`, { method: 'POST', body: { reason } }), onSuccess: onDone });
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {save.error ? <Alert title="Could not exclude">{save.error.message}</Alert> : null}
      <p className="text-sm text-fg-muted">Exclude a line only when it is not a real movement of money, for example a duplicate in the bank&apos;s file. Excluded lines do not count towards the statement balance when reconciling.</p>
      <Field label="Reason" hint="Kept in the audit trail.">{(p) => <Input {...p} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      <div className="flex justify-end"><Button type="submit" variant="danger" loading={save.isPending}>Exclude line</Button></div>
    </form>
  );
}
