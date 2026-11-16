'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { D, dec, JournalValidationError, sum, validateJournal, type PostingAccount } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th, cn } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { money, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import { can, type Journal } from '@/lib/types';

interface LineState {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  currency: string;
  exchangeRate: string;
  description: string;
}

const AMOUNT = /^\d{0,18}(\.\d{0,6})?$/;

export function JournalForm({ existing }: { existing?: Journal }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const router = useRouter();
  const qc = useQueryClient();
  const c = org?.functionalCurrency ?? 'INR';
  const nextKey = useRef(3);
  const idemKey = useRef(newIdempotencyKey('web-journal'));
  const blank = (key: number): LineState => ({ key, accountId: '', debit: '', credit: '', currency: c, exchangeRate: '', description: '' });

  const [jdate, setDate] = useState(existing?.date ?? today());
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [type, setType] = useState(existing?.type ?? 'STANDARD');
  const [showFx, setShowFx] = useState(existing ? existing.lines.some((l) => l.currency !== c) : false);
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((l, i) => ({
          key: i + 1,
          accountId: l.accountId,
          debit: dec(l.debit).isZero() ? '' : l.debit,
          credit: dec(l.credit).isZero() ? '' : l.credit,
          currency: l.currency,
          exchangeRate: l.currency === c ? '' : l.exchangeRate,
          description: l.description ?? '',
        }))
      : [blank(1), blank(2)],
  );

  // Receivables and payables control accounts only take postings from invoices, bills and payments.
  const postable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.id !== org?.arAccountId && a.id !== org?.apAccountId),
    [accounts.data, org?.arAccountId, org?.apAccountId],
  );
  const accountMap = useMemo(
    () => new Map<string, PostingAccount>((accounts.data ?? []).map((a) => [a.id, { id: a.id, code: a.code, type: a.type, isPostable: a.isPostable, isActive: a.isActive }])),
    [accounts.data],
  );

  const payloadLines = lines
    .filter((l) => l.accountId || l.debit || l.credit)
    .map((l) => ({
      accountId: l.accountId,
      debit: l.debit || undefined,
      credit: l.credit || undefined,
      currency: l.currency !== c ? l.currency : undefined,
      exchangeRate: l.currency !== c ? l.exchangeRate || undefined : undefined,
      description: l.description || undefined,
    }));

  // Live check with the same engine the server uses.
  const check = useMemo(() => {
    try {
      const v = validateJournal(payloadLines, { functionalCurrency: c, accounts: accountMap });
      return { ok: true as const, debit: v.totalFunctionalDebit.toFixed(2), credit: v.totalFunctionalCredit.toFixed(2), issues: [] as string[] };
    } catch (e) {
      const issues = e instanceof JournalValidationError ? e.issues : [(e as Error).message];
      // Running totals of the functional-currency lines that parse, for display while typing.
      const safe = (s?: string) => (s && /^\d+(\.\d+)?$/.test(s) ? dec(s) : new D(0));
      const own = payloadLines.filter((l) => !l.currency);
      const d = sum(own.map((l) => safe(l.debit)));
      const cr = sum(own.map((l) => safe(l.credit)));
      return { ok: false as const, debit: d.toFixed(2), credit: cr.toFixed(2), issues };
    }
  }, [payloadLines, c, accountMap]);

  const save = useMutation({
    mutationFn: (post: boolean) => {
      const body = { date: jdate, memo: memo || undefined, reference: reference || undefined, type, lines: payloadLines };
      return existing
        ? api<Journal>(`/v1/orgs/${orgId}/journals/${existing.id}`, { method: 'PUT', body }).then((j) => (post ? api<Journal>(`/v1/orgs/${orgId}/journals/${j.id}/post`, { method: 'POST' }) : j))
        : api<Journal>(`/v1/orgs/${orgId}/journals`, { method: 'POST', body: { ...body, post }, idempotencyKey: `${idemKey.current}-${post ? 'p' : 'd'}` });
    },
    onSuccess: async (j) => {
      await qc.invalidateQueries({ queryKey: ['journals', orgId] });
      await qc.invalidateQueries({ queryKey: ['dashboard', orgId] });
      router.push(`/orgs/${orgId}/journals/${j.id}`);
    },
  });

  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const amountChange = (key: number, side: 'debit' | 'credit', v: string) => {
    if (!AMOUNT.test(v)) return;
    // A line is either a debit or a credit: typing on one side clears the other.
    update(key, side === 'debit' ? (v ? { debit: v, credit: '' } : { debit: v }) : v ? { credit: v, debit: '' } : { credit: v });
  };
  const serverIssues = save.error instanceof ApiError ? save.error.issues : [];
  const draftedIssues = check.issues.filter((i) => !/either debit or credit/.test(i) || payloadLines.length > 0);

  if (!org) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
      className="flex flex-col gap-6"
    >
      <Card className="grid gap-4 p-5 sm:grid-cols-4">
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Date
          <Input type="date" value={jdate} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted sm:col-span-2">
          Memo
          <Input value={memo} maxLength={1000} placeholder="What is this entry for?" onChange={(e) => setMemo(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Type
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="STANDARD">Standard</option>
            <option value="ADJUSTING">Adjusting</option>
            <option value="OPENING">Opening balance</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Reference
          <Input value={reference} maxLength={100} placeholder="Optional" onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-muted sm:col-span-3">
          <input type="checkbox" checked={showFx} onChange={(e) => setShowFx(e.target.checked)} className="accent-[var(--t2t-accent)]" />
          Some lines are in a foreign currency
        </label>
      </Card>

      <Card>
        <CardHeader title="Lines" description={`Amounts in ${c} unless a line says otherwise. Each line is either a debit or a credit.`} />
        <Table>
          <thead>
            <tr>
              <Th className="w-[34%]">Account</Th>
              <Th>Description</Th>
              {showFx ? <Th>Currency / rate</Th> : null}
              <Th numeric>Debit</Th>
              <Th numeric>Credit</Th>
              <Th><span className="sr-only">Remove</span></Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={l.key} className="align-top">
                <Td>
                  <label className="sr-only" htmlFor={`acc-${l.key}`}>Account for line {idx + 1}</label>
                  <Select id={`acc-${l.key}`} value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })}>
                    <option value="">Select account…</option>
                    {postable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td>
                  <Input aria-label={`Description for line ${idx + 1}`} value={l.description} maxLength={500} onChange={(e) => update(l.key, { description: e.target.value })} />
                </Td>
                {showFx ? (
                  <Td>
                    <div className="flex gap-2">
                      <Select aria-label={`Currency for line ${idx + 1}`} className="w-24" value={l.currency} onChange={(e) => update(l.key, { currency: e.target.value })}>
                        {[c, ...['USD', 'EUR', 'GBP', 'AED', 'SGD', 'INR'].filter((x) => x !== c)].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </Select>
                      {l.currency !== c ? (
                        <Input aria-label={`Exchange rate for line ${idx + 1}`} className="w-28" inputMode="decimal" placeholder={`${c} per 1`} value={l.exchangeRate} onChange={(e) => /^\d{0,8}(\.\d{0,10})?$/.test(e.target.value) && update(l.key, { exchangeRate: e.target.value })} />
                      ) : null}
                    </div>
                  </Td>
                ) : null}
                <Td numeric>
                  <Input aria-label={`Debit for line ${idx + 1}`} className="text-right num" inputMode="decimal" value={l.debit} placeholder="0.00" onChange={(e) => amountChange(l.key, 'debit', e.target.value)} />
                </Td>
                <Td numeric>
                  <Input aria-label={`Credit for line ${idx + 1}`} className="text-right num" inputMode="decimal" value={l.credit} placeholder="0.00" onChange={(e) => amountChange(l.key, 'credit', e.target.value)} />
                </Td>
                <Td>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${idx + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    ✕
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={showFx ? 3 : 2}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(nextKey.current++)])}>
                  + Add line
                </Button>
              </Td>
              <Td numeric className="font-semibold">{money(check.debit, c)}</Td>
              <Td numeric className="font-semibold">{money(check.credit, c)}</Td>
              <Td />
            </tr>
          </tfoot>
        </Table>
        <div className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 text-sm', check.ok ? 'text-positive' : 'text-fg-muted')} aria-live="polite">
          {check.ok ? (
            <span>✓ Balanced: debits equal credits ({money(check.debit, c)})</span>
          ) : (
            <ul className="list-inside list-disc text-warning">
              {draftedIssues.slice(0, 4).map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {save.error ? (
        <Alert title="The server rejected this journal">
          {save.error.message}
          {serverIssues.length ? (
            <ul className="mt-1 list-inside list-disc">
              {serverIssues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="button" variant="secondary" loading={save.isPending && save.variables === false} disabled={!check.ok || save.isPending} onClick={() => save.mutate(false)}>
          Save as draft
        </Button>
        {can(org.role, 'journals.post') ? (
          <Button type="button" loading={save.isPending && save.variables === true} disabled={!check.ok || save.isPending} onClick={() => save.mutate(true)}>
            {existing ? 'Save and post' : 'Post journal'}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
