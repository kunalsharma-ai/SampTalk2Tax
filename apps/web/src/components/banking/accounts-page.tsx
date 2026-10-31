'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
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
      <NewBankAccountDialog open={open} onOpenChange={setOpen} />
    </>
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
