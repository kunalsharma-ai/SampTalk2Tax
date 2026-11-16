'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { computeExpenseClaim, DocumentValidationError, type TaxRateInfo } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ExpenseClaim, ExpenseOptions } from '@/lib/types';

interface LineState {
  key: number;
  date: string;
  accountId: string;
  merchant: string;
  description: string;
  amount: string;
  taxRateId: string;
}

const AMOUNT = /^\d{0,15}(\.\d{0,2})?$/;

export function useExpenseOptions() {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['expense-options', orgId], queryFn: () => api<ExpenseOptions>(`/v1/orgs/${orgId}/expense-claims/options`) });
}

/** New claim, or edit a draft / rejected claim. Totals use the same calculation as the server. */
export function ClaimForm({ existing, onCancel }: { existing?: ExpenseClaim; onCancel?: () => void }) {
  const { orgId } = useOrg();
  const options = useExpenseOptions();
  const router = useRouter();
  const qc = useQueryClient();
  const nextKey = useRef(100);
  const blank = (key: number): LineState => ({ key, date: today(), accountId: '', merchant: '', description: '', amount: '', taxRateId: '' });
  const [title, setTitle] = useState(existing?.title ?? '');
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((x, i) => ({ key: i + 1, date: x.date, accountId: x.accountId, merchant: x.merchant ?? '', description: x.description ?? '', amount: x.amount, taxRateId: x.taxRateId ?? '' }))
      : [blank(1)],
  );
  const c = options.data?.currency ?? existing?.currency ?? 'INR';
  // The server only offers tax rates that have a purchase-tax account, so any account id works for the preview.
  const taxMap = useMemo(() => new Map<string, TaxRateInfo>((options.data?.taxRates ?? []).map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate, accountId: 'preview' }])), [options.data]);
  const filled = lines.filter((x) => x.accountId || x.amount || x.merchant || x.description);
  const payload = filled.map((x) => ({ date: x.date, accountId: x.accountId, merchant: x.merchant || null, description: x.description || null, amount: x.amount || '0', taxRateId: x.taxRateId || null }));
  const calc = useMemo(() => {
    const issues: string[] = [];
    if (!title.trim()) issues.push('Give the claim a title');
    payload.forEach((x, i) => {
      if (!x.accountId) issues.push(`Line ${i + 1}: choose a category`);
      if (x.date > today()) issues.push(`Line ${i + 1}: the date is in the future`);
    });
    try {
      const r = computeExpenseClaim(payload, c, taxMap);
      return { ok: issues.length === 0, issues, lines: r.lines, total: r.total.toFixed(2), tax: r.taxTotal.toFixed(2) };
    } catch (e) {
      return { ok: false, issues: [...issues, ...(e instanceof DocumentValidationError ? e.issues : [(e as Error).message])], lines: [], total: null, tax: null };
    }
  }, [payload, c, taxMap, title]);
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
        <CardHeader title="What you spent" description={`One line per receipt, in ${c}, as the receipt shows it (tax included). If a tax rate applies, the recoverable tax is worked out of that amount. You can attach receipts after saving.`} />
        <Table>
          <thead>
            <tr>
              <Th className="w-40">Date</Th>
              <Th className="w-[22%]">Category</Th>
              <Th>Merchant</Th>
              <Th>Description</Th>
              <Th numeric className="w-36">Amount paid</Th>
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
                  <Td><Input type="date" aria-label={`Date for line ${n}`} max={today()} value={x.date} onChange={(e) => update(x.key, { date: e.target.value })} /></Td>
                  <Td>
                    <Select aria-label={`Category for line ${n}`} value={x.accountId} onChange={(e) => update(x.key, { accountId: e.target.value })}>
                      <option value="">Choose…</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                    </Select>
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
                  <Td><Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${n}`} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((y) => y.key !== x.key))}>✕</Button></Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={4}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { ...blank(nextKey.current++), date: ls[ls.length - 1]?.date ?? today() }])}>+ Add line</Button>
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
