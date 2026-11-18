'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkDepositTerms, depositInterest, depositMaturityValue, minorUnits } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Stat } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { COMPOUNDING, type DepositAccounts, type DepositCompounding, type DepositDetail } from '@/lib/deposits';
import { date } from '@/lib/format';
import { today } from '@/lib/loans';
import { useOrg } from '@/lib/org';

const PERIOD: Record<DepositCompounding, string> = { MONTHLY: 'month', QUARTERLY: 'quarter', HALF_YEARLY: 'half year', YEARLY: 'year', SIMPLE: '' };
const yearLater = (d: string) => `${+d.slice(0, 4) + 1}${d.slice(4)}`;

export default function NewDepositPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['deposit-accounts', orgId], queryFn: () => api<DepositAccounts>(`/v1/orgs/${orgId}/deposits/accounts`) });
  const [f, setF] = useState({
    name: '',
    institution: '',
    institutionRef: '',
    principal: '',
    annualRate: '',
    compounding: 'QUARTERLY' as DepositCompounding,
    startDate: today(),
    maturityDate: yearLater(today()),
    bankAccountId: '',
    depositAccountId: '',
    accruedInterestAccountId: '',
    interestIncomeAccountId: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const acc = accounts.data;
  const pick = (v: string, list?: { id: string; code: string; name: string }[], prefer?: (a: { code: string; name: string }) => boolean, not?: string) =>
    v || list?.find((x) => x.id !== not && prefer?.(x))?.id || list?.find((x) => x.id !== not)?.id || '';
  const bankId = pick(f.bankAccountId, acc?.bank, (a) => a.code === '1120');
  const depositId = pick(f.depositAccountId, acc?.deposit, (a) => /deposit/i.test(a.name) && !/interest|accrued/i.test(a.name));
  const accruedId = pick(f.accruedInterestAccountId, acc?.accruedInterest, (a) => /accrued|interest/i.test(a.name), depositId);
  const incomeId = pick(f.interestIncomeAccountId, acc?.interestIncome, (a) => /interest/i.test(a.name));
  const scale = minorUnits(org?.functionalCurrency ?? 'INR');
  const terms = { principal: f.principal.replace(/,/g, ''), annualRate: f.annualRate, compounding: f.compounding, startDate: f.startDate, maturityDate: f.maturityDate };
  const preview = useMemo(() => {
    if (!terms.principal || !terms.annualRate) return { value: null, issues: [] as string[] };
    const issues = checkDepositTerms(terms);
    if (issues.length) return { value: null, issues };
    const m = depositMaturityValue(terms, scale);
    return { value: { ...m, toDate: depositInterest(terms, today(), scale) }, issues };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms.principal, terms.annualRate, terms.compounding, terms.startDate, terms.maturityDate, scale]);
  const save = useMutation({
    mutationFn: () =>
      api<DepositDetail>(`/v1/orgs/${orgId}/deposits`, {
        method: 'POST',
        body: { ...terms, name: f.name, institution: f.institution, institutionRef: f.institutionRef || null, bankAccountId: bankId, depositAccountId: depositId, accruedInterestAccountId: accruedId, interestIncomeAccountId: incomeId },
      }),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ['deposits', orgId] });
      router.push(`/orgs/${orgId}/deposits/${d.id}`);
    },
  });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const missing = acc && (!acc.bank.length || acc.deposit.length < 2 || !acc.interestIncome.length);
  const choose = (value: string, k: keyof typeof f, list?: { id: string; code: string; name: string }[]) => (p: object) => (
    <Select {...p} value={value} onChange={set(k)}>{list?.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>
  );
  return (
    <>
      <PageHeader title="Place a deposit" description="What it will pay is worked out as you type, with the same rules the server uses. Placing it posts Dr the deposit account, Cr the bank account on the start date." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Card className="p-5 xl:col-span-3">
          <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            {missing ? (
              <Alert tone="warning" title="Accounts needed">
                A deposit needs a bank account, two other current asset accounts (one for the deposit, one for interest accrued on it) and an other income account for the interest. <Link className="underline" href={`/orgs/${orgId}/accounts`}>Open the chart of accounts</Link>
              </Alert>
            ) : null}
            <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Name" hint="For example One-year FD">{(p) => <Input {...p} value={f.name} onChange={set('name')} maxLength={200} required />}</Field>
              <Field label="Bank or institution">{(p) => <Input {...p} value={f.institution} onChange={set('institution')} maxLength={200} required />}</Field>
              <Field label="Deposit number (optional)">{(p) => <Input {...p} value={f.institutionRef} onChange={set('institutionRef')} maxLength={60} />}</Field>
            </section>
            <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Amount deposited">{(p) => <Input {...p} inputMode="decimal" value={f.principal} onChange={set('principal')} placeholder="0.00" required />}</Field>
              <Field label="Interest rate (% a year)">{(p) => <Input {...p} inputMode="decimal" value={f.annualRate} onChange={set('annualRate')} placeholder="7.25" required />}</Field>
              <Field label="Interest compounds">
                {(p) => (
                  <Select {...p} value={f.compounding} onChange={set('compounding')}>
                    {Object.entries(COMPOUNDING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Start date">{(p) => <Input {...p} type="date" value={f.startDate} max={today()} onChange={set('startDate')} required />}</Field>
              <Field label="Maturity date">{(p) => <Input {...p} type="date" value={f.maturityDate} onChange={set('maturityDate')} required />}</Field>
            </section>
            <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Paid from" hint="Bank or cash account">{choose(bankId, 'bankAccountId', acc?.bank)}</Field>
              <Field label="Deposit account" hint="Holds the principal">{choose(depositId, 'depositAccountId', acc?.deposit)}</Field>
              <Field label="Interest accrued account" hint="Interest earned but not yet paid">{choose(accruedId, 'accruedInterestAccountId', acc?.accruedInterest)}</Field>
              <Field label="Interest income account">{choose(incomeId, 'interestIncomeAccountId', acc?.interestIncome)}</Field>
            </section>
            {preview.issues.length ? <p className="text-sm text-warning">{preview.issues[0]}</p> : null}
            <ErrorAlert title="Not placed" error={save.error} />
            <div><Button type="submit" loading={save.isPending} disabled={!preview.value || !!missing || !f.name.trim() || !f.institution.trim()}>Place deposit</Button></div>
          </form>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          {preview.value ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="At maturity" value={<Money value={preview.value.value.toFixed(scale)} currency={cur} />} tone="accent" sub={`On ${date(f.maturityDate)}`} />
                <Stat label="Interest" value={<Money value={preview.value.interest.toFixed(scale)} currency={cur} />} tone="violet" sub="Before tax deducted" />
              </div>
              <Card className="p-4 text-sm">
                <CardHeader title="How interest is worked out" />
                <p className="mt-2 text-fg-muted">
                  {f.compounding === 'SIMPLE'
                    ? 'Interest is earned on the amount deposited only, by days on a 365-day year.'
                    : `Interest is added to the balance at the end of each ${PERIOD[f.compounding]} from the start date, and the part period after the last one earns simple interest by days on a 365-day year.`}
                </p>
                {f.startDate < today() ? <p className="mt-2">Earned to today: <Money value={preview.value.toDate.toFixed(scale)} currency={cur} /></p> : null}
              </Card>
            </>
          ) : (
            <Card className="p-5 text-sm text-fg-muted">Enter the amount, rate and dates to see what the deposit will pay.</Card>
          )}
        </div>
      </div>
    </>
  );
}
