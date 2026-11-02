'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { today, type DeferralAccounts, type DeferralKind, type DeferralMethod, type ScheduleDetail } from '@/lib/deferrals';

type Mode = { kind: 'new'; deferral: DeferralKind } | { kind: 'edit'; schedule: ScheduleDetail };

/** The last day covered, as the API works it out: the start date plus the months, less a day. */
function endDate(start: string, months: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !months) return null;
  const y = +start.slice(0, 4);
  const m = +start.slice(5, 7) - 1 + months;
  const d = +start.slice(8, 10);
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last)) - 86_400_000).toISOString().slice(0, 10);
}

export function ScheduleForm({ orgId, mode, onSaved }: { orgId: string; mode: Mode; onSaved: (s: ScheduleDetail) => void }) {
  const base = `/v1/orgs/${orgId}/deferrals`;
  const accounts = useQuery({ queryKey: ['deferral-accounts', orgId], queryFn: () => api<DeferralAccounts>(`${base}/accounts`) });
  const s = mode.kind === 'edit' ? mode.schedule : null;
  const kind: DeferralKind = s ? s.kind : mode.kind === 'new' ? mode.deferral : 'PREPAID_EXPENSE';
  const prepaid = kind === 'PREPAID_EXPENSE';
  const fixed = !!s?.termsFixed;
  const [f, setF] = useState({
    name: s?.name ?? '',
    counterparty: s?.counterparty ?? '',
    balanceAccountId: s?.accounts.balance?.id ?? '',
    pnlAccountId: s?.accounts.pnl?.id ?? '',
    amount: s?.amount ?? '',
    startDate: s?.startDate ?? `${today().slice(0, 7)}-01`,
    months: s ? String(s.months) : '12',
    method: (s?.method ?? 'EVEN') as DeferralMethod,
    record: true,
    fundingAccountId: '',
    fundingDate: today(),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const acc = accounts.data;
  const balanceList = prepaid ? acc?.prepaid : acc?.deferred;
  const pnlList = prepaid ? acc?.expense : acc?.revenue;
  const pick = (v: string, list?: { id: string; code: string }[], prefer?: string) => v || list?.find((x) => x.code === prefer)?.id || list?.[0]?.id || '';
  const balanceId = pick(f.balanceAccountId, balanceList, prepaid ? '1400' : '2350');
  const pnlId = pick(f.pnlAccountId, pnlList);
  const fundingId = pick(f.fundingAccountId, acc?.funding, '1120');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        counterparty: f.counterparty || null,
        balanceAccountId: balanceId,
        pnlAccountId: pnlId,
        amount: f.amount.replace(/,/g, ''),
        startDate: f.startDate,
        months: Number(f.months),
        method: f.method,
      };
      return mode.kind === 'new'
        ? api<ScheduleDetail>(base, { method: 'POST', body: { ...body, kind, fundingAccountId: f.record ? fundingId : null, fundingDate: f.record ? f.fundingDate : null } })
        : api<ScheduleDetail>(`${base}/${mode.schedule.id}`, { method: 'PUT', body });
    },
    onSuccess: onSaved,
  });
  const missing = acc && (!balanceList?.length || !pnlList?.length);
  const end = endDate(f.startDate, Number(f.months));
  return (
    <Card className="p-5">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {missing ? (
          <Alert tone="warning" title="Accounts needed">
            {prepaid ? 'A prepaid expense needs a prepaid (or other current asset) account and an expense account.' : 'Deferred revenue needs a liability account to hold it (for example 2350 Deferred Revenue, an other current liability) and a revenue account.'}{' '}
            <Link className="underline" href={`/orgs/${orgId}/accounts`}>Open the chart of accounts</Link>
          </Alert>
        ) : null}
        {fixed ? (
          <Alert tone="neutral" title="A release has been posted for this schedule">
            Its amount, dates, accounts and method are fixed. Its name and {prepaid ? 'supplier' : 'customer'} can still change.
          </Alert>
        ) : null}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" hint={prepaid ? 'For example Office insurance 2026-27' : 'For example Annual support contract'}>{(p) => <Input {...p} value={f.name} onChange={set('name')} maxLength={200} required />}</Field>
          <Field label={prepaid ? 'Supplier' : 'Customer'}>{(p) => <Input {...p} value={f.counterparty} onChange={set('counterparty')} maxLength={200} />}</Field>
        </section>
        <fieldset disabled={fixed} className="flex flex-col gap-5 disabled:opacity-70">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label={prepaid ? 'Prepaid account' : 'Deferred revenue account'} hint="Holds what is not released yet">{(p) => <Select {...p} value={balanceId} onChange={set('balanceAccountId')}>{balanceList?.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
            <Field label={prepaid ? 'Expense account' : 'Revenue account'} hint="Where each month's share goes">{(p) => <Select {...p} value={pnlId} onChange={set('pnlAccountId')}>{pnlList?.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
          </section>
          <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Amount">{(p) => <Input {...p} inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0.00" required />}</Field>
            <Field label="Covers from">{(p) => <Input {...p} type="date" value={f.startDate} onChange={set('startDate')} required />}</Field>
            <Field label="For (months)" hint={end ? `To ${new Date(`${end}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.months} onChange={set('months')} />}</Field>
            <Field label="Release">
              {(p) => (
                <Select {...p} value={f.method} onChange={set('method')}>
                  <option value="EVEN">Evenly by month</option>
                  <option value="DAILY">By days (part months get their share)</option>
                </Select>
              )}
            </Field>
          </section>
          {mode.kind === 'new' ? (
            <section className="flex flex-col gap-3 rounded-md border border-line p-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.record} onChange={(e) => setF((x) => ({ ...x, record: e.target.checked }))} />
                {prepaid ? 'Post the payment now (debit the prepaid account, credit the account it was paid from)' : 'Post the receipt now (debit the account it was received into, credit deferred revenue)'}
              </label>
              {f.record ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <Field label={prepaid ? 'Paid from' : 'Received into'} hint="Bank, cash or a clearing account">{(p) => <Select {...p} value={fundingId} onChange={set('fundingAccountId')}>{acc?.funding.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
                  <Field label={prepaid ? 'Paid on' : 'Received on'}>{(p) => <Input {...p} type="date" value={f.fundingDate} max={today()} onChange={set('fundingDate')} />}</Field>
                </div>
              ) : (
                <p className="text-xs text-fg-muted">Leave this off when it is already in the books, for example a bill or invoice coded to the {prepaid ? 'prepaid' : 'deferred revenue'} account.</p>
              )}
            </section>
          ) : null}
        </fieldset>
        <ErrorAlert title="Not saved" error={save.error} />
        <div>
          <Button type="submit" loading={save.isPending} disabled={!acc || !!missing}>{mode.kind === 'new' ? (prepaid ? 'Add prepaid expense' : 'Add deferred revenue') : 'Save changes'}</Button>
        </div>
      </form>
    </Card>
  );
}
