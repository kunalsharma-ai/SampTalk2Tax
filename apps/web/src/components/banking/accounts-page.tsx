'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import { can, type BankAccountSummary } from '@/lib/types';

export function useBankAccounts() {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['bank-accounts', orgId], queryFn: () => api<BankAccountSummary[]>(`/v1/orgs/${orgId}/banking/accounts`) });
}

export function BankAccountsPage() {
  const { org, orgId } = useOrg();
  const q = useBankAccounts();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!org) return null;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Bank accounts"
        description="Import statements, match each line to the books and reconcile. A bank account here is a bank or cash account in your chart of accounts. There is no live bank feed: statements come from CSV files you download from your bank."
        actions={can(org.role, 'accounts.manage') ? <Button onClick={() => setOpen(true)}>New bank account</Button> : null}
      />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      <Card>
        {q.data && q.data.length === 0 ? (
          <EmptyState title="No bank accounts">Add the accounts you hold at banks so you can import their statements.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th numeric>Balance in the books</Th>
                <Th>Statement lines</Th>
                <Th>To review</Th>
                <Th>Reconciled to</Th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((a) => {
                const href = `/orgs/${orgId}/banking/${a.id}`;
                return (
                  <Tr key={a.id} className="cursor-pointer" onClick={() => router.push(href)}>
                    <Td>
                      <Link className="text-accent hover:underline" href={href} onClick={(e) => e.stopPropagation()}>{a.code} · {a.name}</Link>
                      <p className="text-xs text-fg-muted">{a.subtype === 'CASH' ? 'Cash' : 'Bank'}{a.isActive ? '' : ' · inactive'}</p>
                    </Td>
                    <Td numeric><Money value={a.ledgerBalance} currency={c} signed /></Td>
                    <Td className="text-fg-muted">{a.statementLines ? `${a.statementLines} · last ${date(a.lastStatementDate!)}` : 'None imported'}</Td>
                    <Td>{a.unmatchedLines ? <Badge tone="warning">{a.unmatchedLines} to review</Badge> : a.statementLines ? <Badge tone="positive">All matched</Badge> : <span className="text-fg-faint">—</span>}</Td>
                    <Td>{a.lastReconciled ? <span>{date(a.lastReconciled.date)} · <Money value={a.lastReconciled.statementBalance} currency={c} /></span> : <span className="text-fg-faint">Never</span>}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {(q.data ?? []).length > 1 ? <TransferSuggestions /> : null}
      <NewBankAccountDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

interface TransferSide {
  id: string;
  accountId: string;
  account: string;
  date: string;
  description: string;
  reference: string | null;
}
interface TransferSuggestion {
  amount: string;
  days: number;
  reasons: string[];
  unique: boolean;
  out: TransferSide;
  in: TransferSide;
}

/** BANK-007: money out of one of your accounts and the same amount into another, recorded as one transfer. */
function TransferSuggestions() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['bank-transfers', orgId], queryFn: () => api<{ items: TransferSuggestion[] }>(`/v1/orgs/${orgId}/banking/transfers/suggestions`) });
  const record = useMutation({
    mutationFn: (s: TransferSuggestion) => api(`/v1/orgs/${orgId}/banking/transfers`, { method: 'POST', body: { outLineId: s.out.id, inLineId: s.in.id } }),
    onSuccess: async () => {
      for (const k of ['bank-transfers', 'bank-accounts', 'bank-lines', 'journals']) await qc.invalidateQueries({ queryKey: [k, orgId] });
    },
  });
  if (!org) return null;
  const items = q.data?.items ?? [];
  const manage = can(org.role, 'banking.manage') && can(org.role, 'journals.post');
  return (
    <Card className="mt-6" role="region" aria-label="Transfers between your accounts">
      <CardHeader
        title="Transfers between your accounts"
        description={items.length ? 'Money out of one of your accounts and the same amount into another within three days. Recording one posts a single transfer entry and matches both statement lines, so neither is booked as income or an expense.' : 'No likely transfers among the unmatched statement lines.'}
      />
      {record.error ? <div className="px-5 pb-3"><Alert title="Transfer not recorded">{record.error.message}{record.error instanceof ApiError && record.error.issues.length ? <ul className="mt-1 list-disc pl-5">{record.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
      {items.length ? (
        <Table>
          <thead><tr><Th>From</Th><Th>To</Th><Th numeric>Amount</Th><Th>Why</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {items.map((s) => (
              <Tr key={`${s.out.id}-${s.in.id}`}>
                <Td><span className="font-medium">{s.out.account}</span><p className="text-xs text-fg-muted">{date(s.out.date)} · {s.out.description}</p></Td>
                <Td><span className="font-medium">{s.in.account}</span><p className="text-xs text-fg-muted">{date(s.in.date)} · {s.in.description}</p></Td>
                <Td numeric><Money value={s.amount} currency={org.functionalCurrency} /></Td>
                <Td className="text-xs text-fg-muted">{s.reasons.join(' · ')}{s.unique ? null : <p className="text-warning">Other lines could also pair; check before recording.</p>}</Td>
                <Td className="whitespace-nowrap text-right">{manage ? <Button size="sm" loading={record.isPending && record.variables === s} aria-label={`Record transfer of ${s.amount} from ${s.out.account} to ${s.in.account}`} onClick={() => record.mutate(s)}>Record transfer</Button> : null}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}

function NewBankAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrg();
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [subtype, setSubtype] = useState<'BANK' | 'CASH'>('BANK');
  const parent = (accounts.data ?? []).find((a) => a.code === '1100' && !a.isPostable) ?? (accounts.data ?? []).find((a) => a.type === 'ASSET' && !a.isPostable);
  const create = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/accounts`, { method: 'POST', body: { code, name, type: 'ASSET', subtype, parentId: parent?.id ?? null } }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] }), qc.invalidateQueries({ queryKey: ['accounts', orgId] })]);
      setCode('');
      setName('');
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New bank account" description={`Adds an asset account${parent ? ` under ${parent.code} · ${parent.name}` : ''} in the chart of accounts.`}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        {create.error ? <div className="sm:col-span-2"><Alert title="Could not add">{create.error.message}</Alert></div> : null}
        <Field label="Code">{(p) => <Input {...p} required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} placeholder="1130" />}</Field>
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={subtype} onChange={(e) => setSubtype(e.target.value as 'BANK' | 'CASH')}>
              <option value="BANK">Bank</option>
              <option value="CASH">Cash</option>
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2"><Field label="Account name">{(p) => <Input {...p} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Current account 4521" />}</Field></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={create.isPending} disabled={!accounts.data}>Add bank account</Button>
        </div>
      </form>
    </Dialog>
  );
}
