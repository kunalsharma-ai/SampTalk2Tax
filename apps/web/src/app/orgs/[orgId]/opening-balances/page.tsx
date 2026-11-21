'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D, minorUnits, OPENING_BALANCE_EQUITY, planOpeningBalances, type OpeningAccount } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg, usePeriods } from '@/lib/org';
import { can } from '@/lib/types';

interface OpeningState {
  currency: string;
  accounts: (OpeningAccount & { subtype: string | null })[];
  offsetAccount: { id: string; code: string; name: string } | null;
  current: {
    journalId: string;
    entryNumber: number;
    date: string;
    balances: { accountId: string; accountCode: string; accountName: string; debit: string; credit: string }[];
    difference: { debit: string; credit: string } | null;
  } | null;
}
type Saved = OpeningState & { journalId: string; warnings: string[] };
type Amounts = Record<string, { debit: string; credit: string }>;

const TYPES: { type: OpeningAccount['type']; label: string }[] = [
  { type: 'ASSET', label: 'Assets' },
  { type: 'LIABILITY', label: 'Liabilities' },
  { type: 'EQUITY', label: 'Equity' },
  { type: 'REVENUE', label: 'Income (only when starting part-way through a year)' },
  { type: 'EXPENSE', label: 'Expenses (only when starting part-way through a year)' },
];
const AMOUNT = /^\d{0,15}(\.\d{0,3})?$/;

export default function OpeningBalancesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const periods = usePeriods();
  const state = useQuery({ queryKey: ['opening-balances', orgId], queryFn: () => api<OpeningState>(`/v1/orgs/${orgId}/opening-balances`) });
  const [on, setOn] = useState('');
  const [amounts, setAmounts] = useState<Amounts>({});
  const [warnings, setWarnings] = useState<string[] | null>(null);

  // Start from what is posted, or from the first day of the earliest fiscal year.
  useEffect(() => {
    if (!state.data) return;
    const first = [...(periods.data ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate))[0]?.startDate ?? '';
    setOn(state.data.current?.date ?? first);
    setAmounts(Object.fromEntries((state.data.current?.balances ?? []).map((b) => [b.accountId, { debit: new D(b.debit).isZero() ? '' : b.debit, credit: new D(b.credit).isZero() ? '' : b.credit }])));
  }, [state.data, periods.data]);

  const lines = useMemo(() => Object.entries(amounts).map(([accountId, a]) => ({ accountId, debit: a.debit, credit: a.credit })), [amounts]);
  const plan = useMemo(
    () => (state.data ? planOpeningBalances({ currency: state.data.currency, accounts: state.data.accounts, lines, offsetAccountId: state.data.offsetAccount?.id ?? 'opening-balance-equity' }) : null),
    [state.data, lines],
  );
  const save = useMutation({
    mutationFn: () => api<Saved>(`/v1/orgs/${orgId}/opening-balances`, { method: 'PUT', body: { date: on, lines } }),
    onSuccess: async (r) => {
      setWarnings(r.warnings);
      await qc.invalidateQueries({ queryKey: ['opening-balances', orgId] });
      await qc.invalidateQueries({ queryKey: ['accounts', orgId] });
    },
  });
  if (!org) return null;
  const s = state.data;
  const c = s?.currency ?? org.functionalCurrency;
  const canPost = can(org.role, 'journals.post');
  const set = (id: string, side: 'debit' | 'credit', v: string) => {
    if (!AMOUNT.test(v)) return;
    setWarnings(null);
    setAmounts((x) => ({ ...x, [id]: { debit: side === 'debit' ? v : v ? '' : x[id]?.debit ?? '', credit: side === 'credit' ? v : v ? '' : x[id]?.credit ?? '' } }));
  };
  const offsetId = s?.offsetAccount?.id ?? 'opening-balance-equity';
  const entered = (side: 'debit' | 'credit') => (plan?.lines ?? []).filter((l) => l.accountId !== offsetId).reduce((t, l) => t.plus(l[side]), new D(0)).toFixed(minorUnits(c));
  const blocking = plan?.issues.filter((i) => i !== 'There is no Opening Balance Equity account to take the difference') ?? [];
  const diff = plan ? new D(plan.difference).cmp(0) : 0;

  return (
    <>
      <PageHeader
        title="Opening balances"
        description="The balances you bring in on the day you start keeping your books in Talk2Tax, posted as one opening journal. Anything that does not balance goes to Opening Balance Equity, so you can post now and clear it once the figures are agreed."
      />
      {state.error ? <Alert title="Could not load opening balances">{state.error instanceof ApiError ? state.error.message : 'Try again.'}</Alert> : null}
      {s?.current ? (
        <div className="mb-4">
          <Alert tone="accent" title={`Posted as JE-${s.current.entryNumber} on ${date(s.current.date)}`}>
            Saving again reverses that journal and posts the new balances in its place; both stay in the <Link className="underline" href={`/orgs/${orgId}/journals/${s.current.journalId}`}>journal history</Link>.
          </Alert>
        </div>
      ) : null}
      <Alert tone="accent" title="Receivables and payables">
        Customers&apos; and vendors&apos; unpaid amounts are not entered here: add the unpaid invoices and bills themselves, so each can be collected or paid. Their accounts take postings only from invoices, bills and payments.
      </Alert>
      <div className="mt-6 flex flex-col gap-6">
        <Card>
          <CardHeader title="Balances to bring in" description={`Amounts in ${c}. Enter each account's balance on the opening date as a debit or a credit.`} />
          <div className="max-w-xs px-5 py-4">
            <Field label="Opening date" hint="Usually the first day of a fiscal year. The period must be open.">
              {(p) => <Input {...p} type="date" value={on} disabled={!canPost} onChange={(e) => setOn(e.target.value)} />}
            </Field>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Account</Th>
                <Th numeric>Debit</Th>
                <Th numeric>Credit</Th>
              </tr>
            </thead>
            {TYPES.map((t) => {
              const rows = (s?.accounts ?? []).filter((a) => a.type === t.type);
              if (!rows.length) return null;
              return (
                <tbody key={t.type}>
                  <tr>
                    <Th colSpan={4} scope="colgroup" className="pt-4 text-left">{t.label}</Th>
                  </tr>
                  {rows.map((a) => (
                    <Tr key={a.id}>
                      <Td className="num text-fg-muted">{a.code}</Td>
                      <Td>{a.name}</Td>
                      <Td numeric>
                        <Input aria-label={`${a.code} ${a.name} debit`} className="num w-36 text-right" inputMode="decimal" placeholder="0.00" disabled={!canPost} value={amounts[a.id]?.debit ?? ''} onChange={(e) => set(a.id, 'debit', e.target.value)} />
                      </Td>
                      <Td numeric>
                        <Input aria-label={`${a.code} ${a.name} credit`} className="num w-36 text-right" inputMode="decimal" placeholder="0.00" disabled={!canPost} value={amounts[a.id]?.credit ?? ''} onChange={(e) => set(a.id, 'credit', e.target.value)} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              );
            })}
            <tfoot>
              <tr>
                <Td colSpan={2} className="font-medium">Entered</Td>
                <Td numeric className="font-medium"><Money value={entered('debit')} currency={c} /></Td>
                <Td numeric className="font-medium"><Money value={entered('credit')} currency={c} /></Td>
              </tr>
              <tr>
                <Td colSpan={2} className="text-fg-muted">To {s?.offsetAccount ? `${s.offsetAccount.code} ${s.offsetAccount.name}` : `${OPENING_BALANCE_EQUITY.code} ${OPENING_BALANCE_EQUITY.name} (added when you save)`}</Td>
                <Td numeric>{diff < 0 ? <Money value={plan!.difference.replace('-', '')} currency={c} /> : null}</Td>
                <Td numeric>{diff > 0 ? <Money value={plan!.difference} currency={c} /> : null}</Td>
              </tr>
            </tfoot>
          </Table>
          {blocking.length ? (
            <div className="mx-5 mt-4">
              <Alert title="Fix these before saving">
                <ul className="list-disc pl-5">{blocking.map((i) => <li key={i}>{i}</li>)}</ul>
              </Alert>
            </div>
          ) : null}
          {plan?.warnings.length ? (
            <div className="mx-5 mt-4">
              <Alert tone="accent" title="Check these">
                <ul className="list-disc pl-5">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </Alert>
            </div>
          ) : null}
          {save.error ? <div className="mx-5 mt-4"><Alert title="Could not post the opening balances">{save.error instanceof ApiError ? save.error.message : 'Try again.'}</Alert></div> : null}
          {save.isSuccess && warnings !== null ? <div className="mx-5 mt-4"><Alert tone="positive" title="Opening balances posted">The trial balance and reports now start from these balances.</Alert></div> : null}
          {canPost ? (
            <div className="flex justify-end px-5 py-4">
              <Button loading={save.isPending} disabled={!s || !on || blocking.length > 0} onClick={() => save.mutate()}>{s?.current ? 'Replace opening balances' : 'Post opening balances'}</Button>
            </div>
          ) : (
            <p className="px-5 py-4 text-sm text-fg-muted">You can see the opening balances; an owner, admin or accountant posts them.</p>
          )}
        </Card>
      </div>
    </>
  );
}
