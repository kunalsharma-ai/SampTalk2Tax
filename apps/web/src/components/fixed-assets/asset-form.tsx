'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Field, Input, Select } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import type { AssetAccounts, AssetDetail, DepreciationMethod } from '@/lib/fixed-assets';

type Mode = { kind: 'new' } | { kind: 'edit'; asset: AssetDetail };

const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function AssetForm({ orgId, mode, onSaved }: { orgId: string; mode: Mode; onSaved: (a: AssetDetail) => void }) {
  const base = `/v1/orgs/${orgId}/fixed-assets`;
  const accounts = useQuery({ queryKey: ['asset-accounts', orgId], queryFn: () => api<AssetAccounts>(`${base}/accounts`) });
  const a = mode.kind === 'edit' ? mode.asset : null;
  const fixed = !!a?.termsFixed;
  const [f, setF] = useState({
    name: a?.name ?? '',
    category: a?.category ?? '',
    serialNumber: a?.serialNumber ?? '',
    location: a?.location ?? '',
    assetAccountId: a?.accounts.asset?.id ?? '',
    accumulatedAccountId: a?.accounts.accumulated?.id ?? '',
    expenseAccountId: a?.accounts.expense?.id ?? '',
    acquisitionDate: a?.acquisitionDate ?? today(),
    inServiceDate: a?.inServiceDate ?? today(),
    cost: a?.cost ?? '',
    residualValue: a?.residualValue ?? '0.00',
    method: (a?.method ?? 'STRAIGHT_LINE') as DepreciationMethod,
    usefulLifeMonths: a?.usefulLifeMonths ? String(a.usefulLifeMonths) : '60',
    annualRate: a?.annualRate ?? '15',
    brought: a ? Number(a.openingAccumulated) > 0 : false,
    openingAccumulated: a?.openingAccumulated ?? '0.00',
    depreciatedThrough: a?.depreciatedThrough ?? '',
    recordPurchase: true,
    fundingAccountId: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const acc = accounts.data;
  const pick = (v: string, list?: { id: string }[]) => v || list?.[0]?.id || '';
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        category: f.category || null,
        serialNumber: f.serialNumber || null,
        location: f.location || null,
        assetAccountId: pick(f.assetAccountId, acc?.asset),
        accumulatedAccountId: pick(f.accumulatedAccountId, acc?.accumulated),
        expenseAccountId: pick(f.expenseAccountId, acc?.expense),
        acquisitionDate: f.acquisitionDate,
        inServiceDate: f.inServiceDate,
        cost: f.cost.replace(/,/g, ''),
        residualValue: (f.residualValue || '0').replace(/,/g, ''),
        method: f.method,
        usefulLifeMonths: f.method === 'STRAIGHT_LINE' ? Number(f.usefulLifeMonths) : null,
        annualRate: f.method === 'WRITTEN_DOWN_VALUE' ? f.annualRate : null,
        openingAccumulated: f.brought ? f.openingAccumulated.replace(/,/g, '') : '0',
        depreciatedThrough: f.brought ? f.depreciatedThrough || null : null,
        ...(mode.kind === 'new' ? { fundingAccountId: !f.brought && f.recordPurchase ? pick(f.fundingAccountId, acc?.funding) : null } : {}),
      };
      return mode.kind === 'new' ? api<AssetDetail>(base, { method: 'POST', body }) : api<AssetDetail>(`${base}/${mode.asset.id}`, { method: 'PUT', body });
    },
    onSuccess: onSaved,
  });
  const missing = acc && (!acc.asset.length || !acc.accumulated.length || !acc.expense.length);
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
            The chart of accounts needs a fixed asset account, an accumulated depreciation account and a depreciation expense account before assets can be added.
          </Alert>
        ) : null}
        {fixed ? (
          <Alert tone="neutral" title="Depreciation has been posted for this asset">
            Its cost, dates, accounts and depreciation terms are fixed. Its name, category, serial number and location can still change.
          </Alert>
        ) : null}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name">{(p) => <Input {...p} value={f.name} onChange={set('name')} maxLength={200} required />}</Field>
          <Field label="Category" hint="For example Computers, Vehicles, Plant">{(p) => <Input {...p} value={f.category} onChange={set('category')} maxLength={100} />}</Field>
          <Field label="Serial number">{(p) => <Input {...p} value={f.serialNumber} onChange={set('serialNumber')} maxLength={100} />}</Field>
          <Field label="Location">{(p) => <Input {...p} value={f.location} onChange={set('location')} maxLength={200} />}</Field>
        </section>
        <fieldset disabled={fixed} className="flex flex-col gap-5 disabled:opacity-70">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Asset account">{(p) => <Select {...p} value={pick(f.assetAccountId, acc?.asset)} onChange={set('assetAccountId')}>{acc?.asset.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
            <Field label="Accumulated depreciation account">{(p) => <Select {...p} value={pick(f.accumulatedAccountId, acc?.accumulated)} onChange={set('accumulatedAccountId')}>{acc?.accumulated.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
            <Field label="Depreciation expense account">{(p) => <Select {...p} value={pick(f.expenseAccountId, acc?.expense)} onChange={set('expenseAccountId')}>{acc?.expense.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
          </section>
          <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Acquired on">{(p) => <Input {...p} type="date" value={f.acquisitionDate} onChange={set('acquisitionDate')} required />}</Field>
            <Field label="Put to use on" hint="Depreciation starts this month">{(p) => <Input {...p} type="date" value={f.inServiceDate} onChange={set('inServiceDate')} required />}</Field>
            <Field label="Cost">{(p) => <Input {...p} inputMode="decimal" value={f.cost} onChange={set('cost')} placeholder="0.00" required />}</Field>
            <Field label="Residual value" hint="What it should be worth at the end">{(p) => <Input {...p} inputMode="decimal" value={f.residualValue} onChange={set('residualValue')} />}</Field>
          </section>
          <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Depreciation method">
              {(p) => (
                <Select {...p} value={f.method} onChange={set('method')}>
                  <option value="STRAIGHT_LINE">Straight line</option>
                  <option value="WRITTEN_DOWN_VALUE">Written-down value</option>
                </Select>
              )}
            </Field>
            {f.method === 'STRAIGHT_LINE' ? (
              <Field label="Useful life (months)" hint="60 months is 5 years">{(p) => <Input {...p} inputMode="numeric" value={f.usefulLifeMonths} onChange={set('usefulLifeMonths')} />}</Field>
            ) : (
              <Field label="Annual rate (%)" hint="On the value at the start of each fiscal year">{(p) => <Input {...p} inputMode="decimal" value={f.annualRate} onChange={set('annualRate')} />}</Field>
            )}
          </section>
          <section className="flex flex-col gap-3 rounded-md border border-line p-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.brought} onChange={(e) => setF((x) => ({ ...x, brought: e.target.checked }))} />
              Already in the books and part-depreciated (brought in from before)
            </label>
            {f.brought ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field label="Accumulated depreciation so far">{(p) => <Input {...p} inputMode="decimal" value={f.openingAccumulated} onChange={set('openingAccumulated')} />}</Field>
                <Field label="Depreciated up to the end of" hint="Depreciation here continues from the month after">{(p) => <Input {...p} type="month" value={f.depreciatedThrough} onChange={set('depreciatedThrough')} />}</Field>
              </div>
            ) : mode.kind === 'new' ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.recordPurchase} onChange={(e) => setF((x) => ({ ...x, recordPurchase: e.target.checked }))} />
                  Post the purchase now (debit the asset account, credit the account it was paid from)
                </label>
                {f.recordPurchase ? (
                  <div className="md:w-1/3">
                    <Field label="Paid from" hint="Bank, cash, a loan, or a clearing account">{(p) => <Select {...p} value={pick(f.fundingAccountId, acc?.funding)} onChange={set('fundingAccountId')}>{acc?.funding.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select>}</Field>
                  </div>
                ) : (
                  <p className="text-xs text-fg-muted">Leave this off when the purchase is already posted, for example from a bill.</p>
                )}
              </>
            ) : null}
          </section>
        </fieldset>
        <ErrorAlert title="Not saved" error={save.error} />
        <div>
          <Button type="submit" loading={save.isPending} disabled={!acc || !!missing}>{mode.kind === 'new' ? 'Add asset' : 'Save changes'}</Button>
        </div>
      </form>
    </Card>
  );
}
