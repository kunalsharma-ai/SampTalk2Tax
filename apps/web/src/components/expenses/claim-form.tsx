'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { computeAllowance, computeExpenseClaim, DocumentValidationError, type TaxRateInfo } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { AllowanceKind, ExpenseClaim, ExpenseOptions } from '@/lib/types';
import { CategorySuggestionHint } from './category-suggestion';
import { ReceiptReader } from './receipt-reader';

interface LineState {
  key: number;
  /** A receipt, or a distance or days claimed at one of the organisation's rates. */
  kind: 'RECEIPT' | AllowanceKind;
  date: string;
  accountId: string;
  merchant: string;
  description: string;
  amount: string;
  taxRateId: string;
  rateId: string;
  quantity: string;
  from: string;
  to: string;
  purpose: string;
  /** The department the cost belongs to (EXP-014); optional. */
  departmentId: string;
  /** The expense category picked (EXP-005); its account is in accountId. Empty when finance picked an account. */
  categoryId: string;
}
const KIND_LABEL = { RECEIPT: 'Receipt', MILEAGE: 'Mileage', PER_DIEM: 'Per diem' } as const;
const QTY = /^\d{0,4}(\.\d{0,1})?$/;

const AMOUNT = /^\d{0,15}(\.\d{0,2})?$/;

export function useExpenseOptions() {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['expense-options', orgId], queryFn: () => api<ExpenseOptions>(`/v1/orgs/${orgId}/expense-claims/options`) });
}

/** New claim, or edit a draft / rejected claim. Totals use the same calculation as the server. */
export function ClaimForm({ existing, onCancel }: { existing?: ExpenseClaim; onCancel?: () => void }) {
  const { orgId } = useOrg();
  const options = useExpenseOptions();
  // Departments are optional: an organisation without any never sees the choice.
  const departments = useQuery({ queryKey: ['expense-departments', orgId], queryFn: () => api<{ departments: { id: string; code: string; name: string }[] }>(`/v1/orgs/${orgId}/expense-departments`), retry: false });
  const deptList = departments.data?.departments ?? [];
  const router = useRouter();
  const qc = useQueryClient();
  const nextKey = useRef(100);
  const blank = (key: number, kind: LineState['kind'] = 'RECEIPT'): LineState => ({ key, kind, date: today(), accountId: '', merchant: '', description: '', amount: '', taxRateId: '', rateId: '', quantity: '', from: '', to: '', purpose: '', departmentId: '', categoryId: '' });
  const [title, setTitle] = useState(existing?.title ?? '');
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((x, i) =>
          x.allowance
            ? { ...blank(i + 1, x.allowance.kind), date: x.date, rateId: x.allowance.rateId, quantity: x.allowance.quantity, from: x.allowance.from ?? '', to: x.allowance.to ?? '', purpose: x.allowance.purpose ?? '', departmentId: x.departmentId ?? '' }
            : { ...blank(i + 1), date: x.date, accountId: x.accountId, merchant: x.merchant ?? '', description: x.description ?? '', amount: x.amount, taxRateId: x.taxRateId ?? '', departmentId: x.departmentId ?? '', categoryId: x.categoryId ?? '' },
        )
      : [blank(1)],
  );
  const c = options.data?.currency ?? existing?.currency ?? 'INR';
  // The server only offers tax rates that have a purchase-tax account, so any account id works for the preview.
  const taxMap = useMemo(() => new Map<string, TaxRateInfo>((options.data?.taxRates ?? []).map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate, accountId: 'preview' }])), [options.data]);
  const rates = options.data?.allowanceRates ?? [];
  const filled = lines.filter((x) => (x.kind === 'RECEIPT' ? x.accountId || x.amount || x.merchant || x.description : x.rateId || x.quantity || x.to));
  // What goes to the server: an allowance line sends its rate and quantity; the server works out the amount.
  const payload = filled.map((x) =>
    x.kind === 'RECEIPT'
      ? { date: x.date, ...(x.categoryId ? { categoryId: x.categoryId, accountId: null } : { accountId: x.accountId }), merchant: x.merchant || null, description: x.description || null, amount: x.amount || '0', taxRateId: x.taxRateId || null, departmentId: x.departmentId || null }
      : { date: x.date, departmentId: x.departmentId || null, allowance: { rateId: x.rateId, quantity: x.quantity || '0', from: x.kind === 'MILEAGE' ? x.from || null : null, to: x.to || null, purpose: x.purpose || null } },
  );
  const calc = useMemo(() => {
    const issues: string[] = [];
    if (!title.trim()) issues.push('Give the claim a title');
    // The same calculation as the server, for the preview.
    const preview = filled.map((x, i) => {
      if (x.date > today()) issues.push(`Line ${i + 1}: the date is in the future`);
      if (x.kind === 'RECEIPT') {
        if (!x.accountId) issues.push(`Line ${i + 1}: choose a category`);
        return { date: x.date, accountId: x.accountId || 'preview', merchant: x.merchant || null, description: x.description || null, amount: x.amount || '0', taxRateId: x.taxRateId || null };
      }
      const r = rates.find((y) => y.id === x.rateId);
      if (!r) {
        issues.push(`Line ${i + 1}: choose a ${x.kind === 'MILEAGE' ? 'mileage' : 'per diem'} rate`);
        return { date: x.date, accountId: 'preview', amount: '0' };
      }
      try {
        const a = computeAllowance({ kind: r.kind, rateName: r.name, rate: r.rate, quantity: x.quantity || '0', from: x.from, to: x.to, purpose: x.purpose }, c);
        return { date: x.date, accountId: r.accountId, amount: a.amount.toFixed(), description: a.description };
      } catch (e) {
        issues.push(`Line ${i + 1}: ${(e as Error).message}`);
        return { date: x.date, accountId: r.accountId, amount: '0' };
      }
    });
    try {
      const r = computeExpenseClaim(preview, c, taxMap);
      return { ok: issues.length === 0, issues, lines: r.lines, total: r.total.toFixed(2), tax: r.taxTotal.toFixed(2) };
    } catch (e) {
      return { ok: false, issues: [...issues, ...(e instanceof DocumentValidationError ? e.issues : [(e as Error).message])], lines: [], total: null, tax: null };
    }
  }, [filled, rates, c, taxMap, title]);
  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), lines: payload };
      return existing
        ? api<ExpenseClaim>(`/v1/orgs/${orgId}/expense-claims/${existing.id}`, { method: 'PUT', body })
        : api<ExpenseClaim>(`/v1/orgs/${orgId}/expense-claims`, { method: 'POST', body });
    },
    onSuccess: async (claim) => {
      await qc.invalidateQueries({ queryKey: ['expense-claims', orgId] });
      await qc.invalidateQueries({ queryKey: ['expense-claim', orgId, claim.id] });
      if (existing && onCancel) onCancel();
      else router.push(`/orgs/${orgId}/expenses/${claim.id}`);
    },
  });
  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const accounts = options.data?.accounts ?? [];
  // With categories set up, people pick one; finance may also claim straight to an account.
  const cats = options.data?.categories ?? [];
  const anyAccount = options.data?.anyAccount ?? true;
  const pick = (key: number, value: string) => {
    if (value.startsWith('cat:')) {
      const k = cats.find((y) => y.id === value.slice(4));
      if (k) update(key, { categoryId: k.id, accountId: k.accountId, ...(k.taxRateId ? { taxRateId: k.taxRateId } : {}) });
    } else update(key, { categoryId: '', accountId: value.startsWith('acc:') ? value.slice(4) : '' });
  };
  const applySuggestion = (key: number, accountId: string) => {
    const k = cats.find((y) => y.accountId === accountId);
    if (k) pick(key, `cat:${k.id}`);
    else if (anyAccount) pick(key, `acc:${accountId}`);
  };
  const taxes = options.data?.taxRates ?? [];
  return (
    <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); if (calc.ok) save.mutate(); }}>
      {options.error ? <Alert title="Could not load categories">{(options.error as Error).message}</Alert> : null}
      <Card className="p-5">
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Title
          <Input value={title} maxLength={200} placeholder="e.g. Client visit, Pune" onChange={(e) => setTitle(e.target.value)} />
        </label>
      </Card>
      <Card>
        <CardHeader title="What you spent" description={`One line per receipt, in ${c}, as the receipt shows it (tax included). If a tax rate applies, the recoverable tax is worked out of that amount. Mileage and per diem lines are worked out from your organisation's rates. You can attach receipts after saving.`} />
        <div className="px-4 pt-3">
          <ReceiptReader
            title="Read a receipt into a line"
            onRead={(r) => {
              const g = r.reading;
              const patch: Partial<LineState> = { ...(g.merchant ? { merchant: g.merchant.value } : {}), ...(g.date ? { date: g.date.value } : {}), ...(g.total ? { amount: g.total.value } : {}) };
              setLines((ls) => {
                const empty = ls.find((x) => x.kind === 'RECEIPT' && !x.amount && !x.merchant);
                return empty ? ls.map((x) => (x.key === empty.key ? { ...x, ...patch } : x)) : [...ls, { ...blank(nextKey.current++), ...patch }];
              });
            }}
          />
        </div>
        <Table>
          <thead>
            <tr>
              <Th className="w-40">Kind and date</Th>
              <Th className="w-[22%]">Category or rate</Th>
              <Th>Merchant or route</Th>
              <Th>Description or purpose</Th>
              <Th numeric className="w-36">Amount paid or quantity</Th>
              <Th className="w-40">Tax</Th>
              <Th><span className="sr-only">Remove</span></Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((x, idx) => {
              const pos = filled.indexOf(x);
              const computed = pos >= 0 ? calc.lines[pos] : undefined;
              const n = idx + 1;
              return (
                <tr key={x.key} className="align-top">
                  <Td>
                    <Select aria-label={`Kind of line ${n}`} value={x.kind} onChange={(e) => update(x.key, { kind: e.target.value as LineState['kind'], rateId: '' })}>
                      <option value="RECEIPT">Receipt</option>
                      {rates.some((r) => r.kind === 'MILEAGE') || x.kind === 'MILEAGE' ? <option value="MILEAGE">Mileage</option> : null}
                      {rates.some((r) => r.kind === 'PER_DIEM') || x.kind === 'PER_DIEM' ? <option value="PER_DIEM">Per diem</option> : null}
                    </Select>
                    <Input className="mt-2" type="date" aria-label={`Date for line ${n}`} max={today()} value={x.date} onChange={(e) => update(x.key, { date: e.target.value })} />
                    {deptList.length || x.departmentId ? (
                      <Select className="mt-2" aria-label={`Department for line ${n}`} value={x.departmentId} onChange={(e) => update(x.key, { departmentId: e.target.value })}>
                        <option value="">No department</option>
                        {deptList.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
                      </Select>
                    ) : null}
                  </Td>
                  {x.kind === 'RECEIPT' ? (
                    <>
                      <Td>
                        <Select aria-label={`Category for line ${n}`} value={x.categoryId ? `cat:${x.categoryId}` : x.accountId ? `acc:${x.accountId}` : ''} onChange={(e) => pick(x.key, e.target.value)}>
                          <option value="">Choose…</option>
                          {x.categoryId && !cats.some((y) => y.id === x.categoryId) ? <option value={`cat:${x.categoryId}`}>{existing?.lines.find((l) => l.categoryId === x.categoryId)?.category ?? 'A category'} (no longer in use)</option> : null}
                          {cats.length ? (
                            <optgroup label="Categories">{cats.map((k) => <option key={k.id} value={`cat:${k.id}`}>{k.name}</option>)}</optgroup>
                          ) : null}
                          {anyAccount || (x.accountId && !x.categoryId) ? (
                            cats.length ? (
                              <optgroup label="Expense accounts">{accounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.code} · {a.name}</option>)}</optgroup>
                            ) : (
                              accounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.code} · {a.name}</option>)
                            )
                          ) : null}
                        </Select>
                        {(() => {
                          const k = cats.find((y) => y.id === x.categoryId);
                          return k && (k.description || k.receipt === 'ALWAYS') ? (
                            <p className="mt-1 text-xs text-fg-muted" data-testid={`category-guidance-${n}`}>
                              {k.description}
                              {k.receipt === 'ALWAYS' ? <span className="block font-medium text-fg">A receipt is always needed.</span> : null}
                            </p>
                          ) : null;
                        })()}
                        <CategorySuggestionHint orgId={orgId} kind="claim-line" line={n} merchant={x.merchant} description={x.description} current={x.accountId} onUse={(accountId) => applySuggestion(x.key, accountId)} />
                      </Td>
                      <Td><Input aria-label={`Merchant for line ${n}`} maxLength={200} value={x.merchant} onChange={(e) => update(x.key, { merchant: e.target.value })} /></Td>
                      <Td><Input aria-label={`Description for line ${n}`} maxLength={500} value={x.description} onChange={(e) => update(x.key, { description: e.target.value })} /></Td>
                      <Td numeric>
                        <Input aria-label={`Amount for line ${n}`} className="num text-right" inputMode="decimal" placeholder="0.00" value={x.amount} onChange={(e) => AMOUNT.test(e.target.value) && update(x.key, { amount: e.target.value })} />
                        {computed && computed.taxAmount.gt(0) ? <p className="mt-1 text-xs text-fg-muted">incl. tax {money(computed.taxAmount.toFixed(2), c)}</p> : null}
                      </Td>
                      <Td>
                        <Select aria-label={`Tax for line ${n}`} value={x.taxRateId} onChange={(e) => update(x.key, { taxRateId: e.target.value })}>
                          <option value="">No tax</option>
                          {taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </Select>
                      </Td>
                    </>
                  ) : (
                    <>
                      <Td>
                        <Select aria-label={`${KIND_LABEL[x.kind]} rate for line ${n}`} value={x.rateId} onChange={(e) => update(x.key, { rateId: e.target.value })}>
                          <option value="">Choose a rate…</option>
                          {rates.filter((r) => r.kind === x.kind).map((r) => <option key={r.id} value={r.id}>{r.name} · {money(r.rate, c)} per {r.unit === 'KM' ? 'km' : 'day'}</option>)}
                        </Select>
                      </Td>
                      <Td>
                        {x.kind === 'MILEAGE' ? (
                          <div className="flex flex-col gap-2">
                            <Input aria-label={`From for line ${n}`} placeholder="From" maxLength={120} value={x.from} onChange={(e) => update(x.key, { from: e.target.value })} />
                            <Input aria-label={`To for line ${n}`} placeholder="To" maxLength={120} value={x.to} onChange={(e) => update(x.key, { to: e.target.value })} />
                          </div>
                        ) : (
                          <Input aria-label={`Place for line ${n}`} placeholder="Where you stayed" maxLength={120} value={x.to} onChange={(e) => update(x.key, { to: e.target.value })} />
                        )}
                      </Td>
                      <Td><Input aria-label={`Purpose for line ${n}`} placeholder="Purpose of the trip" maxLength={200} value={x.purpose} onChange={(e) => update(x.key, { purpose: e.target.value })} /></Td>
                      <Td numeric>
                        <Input aria-label={`${x.kind === 'MILEAGE' ? 'Kilometres' : 'Days'} for line ${n}`} className="num text-right" inputMode="decimal" placeholder={x.kind === 'MILEAGE' ? 'km' : 'days'} value={x.quantity} onChange={(e) => QTY.test(e.target.value) && update(x.key, { quantity: e.target.value })} />
                        <p className="mt-1 text-xs text-fg-muted">{computed ? `= ${money(computed.amount.toFixed(2), c)}` : x.kind === 'MILEAGE' ? 'kilometres' : 'whole or half days'}</p>
                      </Td>
                      <Td className="text-xs text-fg-faint">No tax</Td>
                    </>
                  )}
                  <Td><Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${n}`} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((y) => y.key !== x.key))}>✕</Button></Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={4}>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { ...blank(nextKey.current++), date: ls[ls.length - 1]?.date ?? today() }])}>+ Add receipt</Button>
                  {rates.some((r) => r.kind === 'MILEAGE') ? <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { ...blank(nextKey.current++, 'MILEAGE'), date: ls[ls.length - 1]?.date ?? today() }])}>+ Add mileage</Button> : null}
                  {rates.some((r) => r.kind === 'PER_DIEM') ? <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { ...blank(nextKey.current++, 'PER_DIEM'), date: ls[ls.length - 1]?.date ?? today() }])}>+ Add per diem</Button> : null}
                </div>
              </Td>
              <Td numeric className="whitespace-nowrap">
                <p className="font-semibold"><span className="sr-only">Claim total </span>{calc.total ? money(calc.total, c) : '—'}</p>
                {calc.tax && calc.tax !== '0.00' ? <p className="text-xs text-fg-muted">incl. tax {money(calc.tax, c)}</p> : null}
              </Td>
              <Td colSpan={2} />
            </tr>
          </tfoot>
        </Table>
      </Card>
      {save.error ? (
        <Alert title="Could not save">
          {save.error.message}
          {save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-disc pl-5">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </Alert>
      ) : null}
      {!calc.ok && filled.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-fg-muted" aria-label="Before you can save">{calc.issues.map((i) => <li key={i}>{i}</li>)}</ul>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" loading={save.isPending} disabled={!calc.ok}>{existing ? 'Save changes' : 'Save draft'}</Button>
      </div>
    </form>
  );
}
