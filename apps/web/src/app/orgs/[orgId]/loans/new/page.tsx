'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkLoanTerms, LoanError, loanSchedule, loanTotals, minorUnits, type LoanMethod } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { today, type LoanAccounts, type LoanDetail } from '@/lib/loans';
import { useOrg } from '@/lib/org';

const nextMonth = (d: string) => {
  const m = +d.slice(5, 7);
  return m === 12 ? `${+d.slice(0, 4) + 1}-01-${d.slice(8, 10)}` : `${d.slice(0, 4)}-${String(m + 1).padStart(2, '0')}-${Math.min(+d.slice(8, 10), 28).toString().padStart(2, '0')}`;
};

export default function NewLoanPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['loan-accounts', orgId], queryFn: () => api<LoanAccounts>(`/v1/orgs/${orgId}/loans/accounts`) });
  const [f, setF] = useState({
    name: '',
    lender: '',
    accountNumber: '',
    method: 'EMI' as LoanMethod,
    principal: '',
    annualRate: '',
    months: '60',
    disbursementDate: today(),
    firstDueDate: nextMonth(today()),
    liabilityAccountId: '',
    interestAccountId: '',
    bankAccountId: '',
    recordDisbursement: true,
    notes: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const acc = accounts.data;
  const pick = (v: string, list?: { id: string; code: string }[], prefer?: string) => v || list?.find((x) => x.code === prefer)?.id || list?.[0]?.id || '';
  const liabilityId = pick(f.liabilityAccountId, acc?.liability, '2700');
  const interestId = pick(f.interestAccountId, acc?.interest, '7100');
  const bankId = pick(f.bankAccountId, acc?.bank, '1120');
  const scale = minorUnits(org?.functionalCurrency ?? 'INR');
  const terms = { principal: f.principal.replace(/,/g, ''), annualRate: f.annualRate, months: Number(f.months), method: f.method, disbursementDate: f.disbursementDate, firstDueDate: f.firstDueDate };
  const preview = useMemo(() => {
    if (!terms.principal || !terms.annualRate) return { rows: null, issues: [] as string[] };
    const issues = checkLoanTerms(terms);
    if (issues.length) return { rows: null, issues };
    try {
      return { rows: loanSchedule(terms, scale), issues };
    } catch (e) {
      return { rows: null, issues: [e instanceof LoanError ? e.message : (e as Error).message] };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms.principal, terms.annualRate, terms.months, terms.method, terms.disbursementDate, terms.firstDueDate, scale]);
  const save = useMutation({
    mutationFn: () =>
      api<LoanDetail>(`/v1/orgs/${orgId}/loans`, {
        method: 'POST',
        body: { ...terms, name: f.name, lender: f.lender || null, accountNumber: f.accountNumber || null, liabilityAccountId: liabilityId, interestAccountId: interestId, bankAccountId: bankId, recordDisbursement: f.recordDisbursement, notes: f.notes || null },
      }),
    onSuccess: async (l) => {
      await qc.invalidateQueries({ queryKey: ['loans', orgId] });
      router.push(`/orgs/${orgId}/loans/${l.id}`);
    },
  });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const totals = preview.rows ? loanTotals(preview.rows, scale) : null;
  const missing = acc && (!acc.liability.length || !acc.interest.length || !acc.bank.length);
  return (
    <>
      <PageHeader title="Add a loan" description="The schedule below is worked out as you type, with the same rules the server uses. To bring in a loan taken earlier, enter what is owed today as the amount, the installments left as the term, and leave posting the money received off." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Card className="p-5 xl:col-span-3">
          <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            {missing ? (
              <Alert tone="warning" title="Accounts needed">
                A loan needs a long-term debt (or other liability) account, an expense account for interest and a bank or cash account. <Link className="underline" href={`/orgs/${orgId}/accounts`}>Open the chart of accounts</Link>
              </Alert>
            ) : null}
            <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Name" hint="For example Warehouse term loan">{(p) => <Input {...p} value={f.name} onChange={set('name')} maxLength={200} required />}</Field>
              <Field label="Lender">{(p) => <Input {...p} value={f.lender} onChange={set('lender')} maxLength={200} />}</Field>
              <Field label="Loan account number">{(p) => <Input {...p} value={f.accountNumber} onChange={set('accountNumber')} maxLength={60} />}</Field>
            </section>
            <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <Field label="Amount borrowed">{(p) => <Input {...p} inputMode="decimal" value={f.principal} onChange={set('principal')} placeholder="0.00" required />}</Field>
              <Field label="Interest rate (% a year)">{(p) => <Input {...p} inputMode="decimal" value={f.annualRate} onChange={set('annualRate')} placeholder="9.5" required />}</Field>
              <Field label="Term (months)">{(p) => <Input {...p} inputMode="numeric" value={f.months} onChange={set('months')} required />}</Field>
              <Field label="Repayment">
                {(p) => (
                  <Select {...p} value={f.method} onChange={set('method')}>
                    <option value="EMI">EMI (equal monthly installments)</option>
                    <option value="EQUAL_PRINCIPAL">Equal principal plus interest</option>
                  </Select>
                )}
              </Field>
              <Field label="Received on">{(p) => <Input {...p} type="date" value={f.disbursementDate} onChange={set('disbursementDate')} required />}</Field>
              <Field label="First installment due">{(p) => <Input {...p} type="date" value={f.firstDueDate} onChange={set('firstDueDate')} required />}</Field>
            </section>
            <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Loan account" hint="Holds what is owed">{(p) => <Select {...p} value={liabilityId} onChange={set('liabilityAccountId')}>{acc?.liability.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
              <Field label="Interest account">{(p) => <Select {...p} value={interestId} onChange={set('interestAccountId')}>{acc?.interest.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
              <Field label="Bank account" hint="Received into and repaid from">{(p) => <Select {...p} value={bankId} onChange={set('bankAccountId')}>{acc?.bank.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
            </section>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.recordDisbursement} onChange={(e) => setF((x) => ({ ...x, recordDisbursement: e.target.checked }))} />
              Post the money received now (debit the bank, credit the loan account)
            </label>
            {!f.recordDisbursement ? <p className="-mt-3 text-xs text-fg-muted">Leave this off when the loan is already in the books, for example from opening balances.</p> : null}
            <Field label="Notes (optional)">{(p) => <Input {...p} value={f.notes} onChange={set('notes')} maxLength={1000} placeholder="Security, covenants, prepayment terms" />}</Field>
            {preview.issues.length ? <p className="text-sm text-warning">{preview.issues[0]}</p> : null}
            <ErrorAlert title="Not added" error={save.error} />
            <div><Button type="submit" loading={save.isPending} disabled={!preview.rows || !!missing || !f.name.trim()}>Add loan</Button></div>
          </form>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          {totals && preview.rows ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Stat label={f.method === 'EMI' ? 'EMI' : 'First installment'} value={<Money value={preview.rows[0]!.payment} currency={cur} />} tone="accent" sub={`${totals.installments} installments to ${date(preview.rows.at(-1)!.dueDate)}`} />
                <Stat label="Total interest" value={<Money value={totals.interest} currency={cur} />} tone="violet" sub={<>Total repaid <Money value={totals.payment} currency={cur} /></>} />
              </div>
              <Card className="max-h-[560px] overflow-auto">
                <div className="p-4 pb-0"><CardHeader title="Repayment schedule" description="Interest each month on the balance at the start of the month." /></div>
                <Table aria-label="Schedule preview">
                  <thead>
                    <tr>
                      <Th>#</Th>
                      <Th>Due</Th>
                      <Th numeric>Interest</Th>
                      <Th numeric>Principal</Th>
                      <Th numeric>Balance</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <Tr key={r.no}>
                        <Td className="text-fg-muted">{r.no}</Td>
                        <Td className="whitespace-nowrap">{date(r.dueDate)}</Td>
                        <Td numeric><Money value={r.interest} currency={cur} /></Td>
                        <Td numeric><Money value={r.principal} currency={cur} /></Td>
                        <Td numeric><Money value={r.closing} currency={cur} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </>
          ) : (
            <Card className="p-5 text-sm text-fg-muted">Enter the amount, rate and term to see the repayment schedule.</Card>
          )}
        </div>
      </div>
    </>
  );
}
