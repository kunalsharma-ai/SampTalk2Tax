'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import type { GroupDetail, IntercompanyAccounts, IntercompanyTxn } from '@/lib/consolidation';
import { date, today } from '@/lib/format';

type Acc = { id: string; code: string; name: string; type: string; subtype: string | null; isPostable: boolean; isActive: boolean };

function useAccounts(orgId: string) {
  return useQuery({
    queryKey: ['accounts', orgId],
    enabled: !!orgId,
    queryFn: () => api<Acc[] | { items: Acc[] }>(`/v1/orgs/${orgId}/accounts`),
    select: (d) => (Array.isArray(d) ? d : d.items).filter((a) => a.isPostable && a.isActive),
  });
}

const PURPOSES: [keyof IntercompanyAccounts, string, string][] = [
  ['receivable', 'Receivable from group companies', 'ASSET'],
  ['payable', 'Payable to group companies', 'LIABILITY'],
  ['revenue', 'Revenue from group companies', 'REVENUE'],
  ['expense', 'Expense from group companies', 'EXPENSE'],
];

/** Setup: the accounts each company uses for intercompany transactions. */
export function IntercompanyAccountsCard({ g, orgId, base, manage }: { g: GroupDetail; orgId: string; base: string; manage: boolean }) {
  return (
    <Card className="mt-4 p-4">
      <CardHeader
        title="Intercompany accounts"
        description="The accounts each company uses for charges and settlements with other group companies. Amounts posted through the Intercompany tab are eliminated exactly, so these accounts cannot also be used in elimination rules."
      />
      <div className="space-y-4">
        {g.members.map((m) => (
          <MemberAccounts key={`${m.orgId}-${JSON.stringify(m.intercompanyAccounts)}`} member={m} orgId={orgId} groupId={g.id} base={base} manage={manage} />
        ))}
      </div>
    </Card>
  );
}

function MemberAccounts({ member, orgId, groupId, base, manage }: { member: GroupDetail['members'][number]; orgId: string; groupId: string; base: string; manage: boolean }) {
  const qc = useQueryClient();
  const [v, setV] = useState<IntercompanyAccounts>(member.intercompanyAccounts);
  const accounts = useAccounts(member.name ? member.orgId : '');
  const save = useMutation({
    mutationFn: () => api<GroupDetail>(`${base}/members/${member.orgId}/intercompany-accounts`, { method: 'PUT', body: { ...v } }),
    onSuccess: (d) => {
      qc.setQueryData(['consolidation-group', orgId, groupId], d);
      void qc.invalidateQueries({ queryKey: ['consolidation-report', orgId, groupId] });
    },
  });
  const changed = JSON.stringify(v) !== JSON.stringify(member.intercompanyAccounts);
  return (
    <section aria-label={`Intercompany accounts of ${member.name ?? 'a company'}`} className="rounded-md border border-line p-3">
      <div className="mb-2 text-sm font-medium text-fg">{member.name ?? 'A company you are not a member of'}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {PURPOSES.map(([k, label, type]) => (
          <Field key={k} label={label}>
            {(p) => (
              <Select {...p} value={v[k] ?? ''} disabled={!manage || !member.name} onChange={(e) => setV({ ...v, [k]: e.target.value || null })}>
                <option value="">Not set</option>
                {(accounts.data ?? []).filter((a) => a.type === type).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </Select>
            )}
          </Field>
        ))}
      </div>
      {save.error ? <div className="mt-2"><ErrorAlert title="Could not save" error={save.error} /></div> : null}
      {manage && changed ? <Button className="mt-2" size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save accounts</Button> : null}
    </section>
  );
}

/** The intercompany tab: post charges and settlements in both companies at once, and reverse them. */
export function IntercompanyTab({ g, orgId, base }: { g: GroupDetail; orgId: string; base: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['intercompany', orgId, g.id], queryFn: () => api<{ items: IntercompanyTxn[]; hidden: number }>(`${base}/intercompany`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['intercompany', orgId, g.id] });
    void qc.invalidateQueries({ queryKey: ['consolidation-report', orgId, g.id] });
  };
  const reverse = useMutation({ mutationFn: (t: IntercompanyTxn) => api<IntercompanyTxn>(`${base}/intercompany/${t.id}/reverse`, { method: 'POST', body: { date: today() } }), onSuccess: refresh });
  return (
    <div className="space-y-4">
      <NewTransaction g={g} base={base} onDone={refresh} />
      <Card className="overflow-x-auto">
        <CardHeader title="Intercompany transactions" description="Each one is posted in both companies' books together, with the same reference. Reversing it reverses both entries." />
        <ErrorAlert title="Could not load the transactions" error={list.error} />
        <ErrorAlert title="Could not reverse" error={reverse.error} />
        {list.data && !list.data.items.length ? <EmptyState title="No intercompany transactions yet">Post a charge or a settlement above.</EmptyState> : null}
        {list.data?.items.length ? (
          <Table aria-label="Intercompany transactions">
            <thead>
              <tr><Th>Reference</Th><Th>Date</Th><Th>Type</Th><Th>From</Th><Th>To</Th><Th>Description</Th><Th numeric>Amount</Th><Th>Entries</Th><Th /></tr>
            </thead>
            <tbody>
              {list.data.items.map((t) => (
                <Tr key={t.id}>
                  <Td className="num">{t.reference}</Td>
                  <Td>{date(t.date)}</Td>
                  <Td>{t.kind === 'CHARGE' ? 'Charge' : 'Settlement'} {t.reversedOn ? <Badge tone="warning">Reversed {date(t.reversedOn)}</Badge> : null}</Td>
                  <Td>{t.from.name}</Td>
                  <Td>{t.to.name}</Td>
                  <Td>{t.description}</Td>
                  <Td numeric className="whitespace-nowrap">
                    <Money value={t.from.amount} currency={t.from.currency} />
                    {t.to.currency !== t.from.currency ? <span className="block text-xs text-fg-muted"><Money value={t.to.amount} currency={t.to.currency} /></span> : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    <EntryLink orgId={t.from.orgId} e={t.from.entry} label="From" /> · <EntryLink orgId={t.to.orgId} e={t.to.entry} label="To" />
                    {t.reversedOn ? <span className="block">Reversals: <EntryLink orgId={t.from.orgId} e={t.from.reversal} label="From" /> · <EntryLink orgId={t.to.orgId} e={t.to.reversal} label="To" /></span> : null}
                  </Td>
                  <Td>
                    {!t.reversedOn ? (
                      <Button size="sm" variant="ghost" aria-label={`Reverse ${t.reference}`} disabled={reverse.isPending} onClick={() => confirm(`Reverse ${t.reference} in both companies today?`) && reverse.mutate(t)}>
                        Reverse
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {list.data?.hidden ? <p className="p-3 text-xs text-fg-muted">{list.data.hidden} transaction{list.data.hidden === 1 ? '' : 's'} between companies whose journals you cannot read are not shown.</p> : null}
      </Card>
    </div>
  );
}

function EntryLink({ orgId, e, label }: { orgId: string; e: { id: string; entryNumber: number | null } | null; label: string }) {
  if (!e) return <span>—</span>;
  return (
    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>
      {label} #{e.entryNumber ?? '?'}
    </Link>
  );
}

function NewTransaction({ g, base, onDone }: { g: GroupDetail; base: string; onDone: () => void }) {
  const members = g.members.filter((m) => m.name);
  const blank = { kind: 'CHARGE' as 'CHARGE' | 'SETTLEMENT', fromOrgId: '', toOrgId: '', date: today(), description: '', amount: '', toAmount: '', fromBankCode: '', toBankCode: '' };
  const [f, setF] = useState(blank);
  const [done, setDone] = useState<IntercompanyTxn | null>(null);
  const from = members.find((m) => m.orgId === f.fromOrgId);
  const to = members.find((m) => m.orgId === f.toOrgId);
  const fromAcc = useAccounts(f.kind === 'SETTLEMENT' ? f.fromOrgId : '');
  const toAcc = useAccounts(f.kind === 'SETTLEMENT' ? f.toOrgId : '');
  const banks = (d: Acc[] | undefined) => (d ?? []).filter((a) => a.type === 'ASSET' && ['BANK', 'CASH'].includes(a.subtype ?? ''));
  const cross = !!from && !!to && from.currency !== to.currency;
  const settle = f.kind === 'SETTLEMENT';
  const save = useMutation({
    mutationFn: () =>
      api<IntercompanyTxn>(`${base}/intercompany`, {
        method: 'POST',
        body: {
          kind: f.kind,
          fromOrgId: f.fromOrgId,
          toOrgId: f.toOrgId,
          date: f.date,
          description: f.description,
          amount: f.amount.trim(),
          toAmount: cross ? f.toAmount.trim() : null,
          fromBankCode: settle ? f.fromBankCode : null,
          toBankCode: settle ? f.toBankCode : null,
        },
      }),
    onSuccess: (t) => {
      setDone(t);
      setF({ ...blank, kind: f.kind, fromOrgId: f.fromOrgId, toOrgId: f.toOrgId });
      onDone();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="p-4">
      <CardHeader
        title="New intercompany transaction"
        description={settle ? 'The second company pays the first: both bank accounts and the intercompany balances move together.' : 'The first company charges the second for goods, services or fees: revenue and a receivable in the first, an expense and a payable in the second.'}
      />
      <form
        className="grid grid-cols-1 gap-3 md:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          save.mutate();
        }}
      >
        <Field label="Type">
          {(p) => (
            <Select {...p} value={f.kind} onChange={set('kind')}>
              <option value="CHARGE">Charge (invoice)</option>
              <option value="SETTLEMENT">Settlement (payment)</option>
            </Select>
          )}
        </Field>
        <Field label={settle ? 'Company receiving the money' : 'Company charging'}>
          {(p) => (
            <Select {...p} value={f.fromOrgId} onChange={(e) => setF({ ...f, fromOrgId: e.target.value, fromBankCode: '' })}>
              <option value="">Choose…</option>
              {members.map((m) => <option key={m.orgId} value={m.orgId}>{m.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={settle ? 'Company paying' : 'Company charged'}>
          {(p) => (
            <Select {...p} value={f.toOrgId} onChange={(e) => setF({ ...f, toOrgId: e.target.value, toBankCode: '' })}>
              <option value="">Choose…</option>
              {members.filter((m) => m.orgId !== f.fromOrgId).map((m) => <option key={m.orgId} value={m.orgId}>{m.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Date">{(p) => <Input {...p} type="date" value={f.date} onChange={set('date')} />}</Field>
        <div className="md:col-span-2">
          <Field label="Description">{(p) => <Input {...p} value={f.description} onChange={set('description')} placeholder="Management fee for October" maxLength={200} />}</Field>
        </div>
        <Field label={`Amount${from?.currency ? ` (${from.currency})` : ''}`}>{(p) => <Input {...p} value={f.amount} onChange={set('amount')} inputMode="decimal" placeholder="0.00" />}</Field>
        {cross ? (
          <Field label={`Amount for ${to!.name} (${to!.currency})`} hint="As booked by the second company, at the rate it used on the day.">
            {(p) => <Input {...p} value={f.toAmount} onChange={set('toAmount')} inputMode="decimal" placeholder="0.00" />}
          </Field>
        ) : (
          <div />
        )}
        {settle ? (
          <>
            <Field label="Bank account receiving">
              {(p) => (
                <Select {...p} value={f.fromBankCode} disabled={!f.fromOrgId} onChange={set('fromBankCode')}>
                  <option value="">Choose…</option>
                  {banks(fromAcc.data).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Bank account paying">
              {(p) => (
                <Select {...p} value={f.toBankCode} disabled={!f.toOrgId} onChange={set('toBankCode')}>
                  <option value="">Choose…</option>
                  {banks(toAcc.data).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </Field>
          </>
        ) : null}
        <div className="flex items-end md:col-span-4">
          <Button type="submit" loading={save.isPending} disabled={!f.fromOrgId || !f.toOrgId || !f.amount}>
            Post in both companies
          </Button>
        </div>
      </form>
      {save.error ? <div className="mt-3"><ErrorAlert title="Not posted" error={save.error} /></div> : null}
      {done ? (
        <p role="status" className="mt-3 text-sm text-positive">
          Posted {done.reference}: entry #{done.from.entry?.entryNumber} in {done.from.name} and entry #{done.to.entry?.entryNumber} in {done.to.name}.
        </p>
      ) : null}
    </Card>
  );
}
