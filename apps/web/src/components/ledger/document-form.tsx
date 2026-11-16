'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addDays, computeDocument, DocumentValidationError, type TaxRateInfo } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { money, today } from '@/lib/format';
import type { LedgerConfig } from '@/lib/ledgers';
import { useAccounts, useContacts, useOrg, useTaxRates } from '@/lib/org';
import { can, type AccountType, type DocumentKind, type FinancialDocument } from '@/lib/types';
import { ContactDialog, draftFrom, type ContactDraft } from './contacts-page';

interface LineState {
  key: number;
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRateId: string;
}

const QTY = /^\d{0,12}(\.\d{0,6})?$/;
const TYPE_ORDER: AccountType[] = ['REVENUE', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'];

export function DocumentForm({ l, kind, existing, contactId }: { l: LedgerConfig; kind: DocumentKind; existing?: FinancialDocument; contactId?: string }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const contacts = useContacts(l.contactRole);
  const taxRates = useTaxRates();
  const router = useRouter();
  const qc = useQueryClient();
  const c = org?.functionalCurrency ?? 'INR';
  const nextKey = useRef(2);
  const blank = (key: number): LineState => ({ key, accountId: '', description: '', quantity: '1', unitPrice: '', taxRateId: '' });
  const isCharge = kind === l.charge.kind;
  const label = isCharge ? l.charge.label : l.credit.label;

  const [contact, setContact] = useState(existing?.contact.id ?? contactId ?? '');
  const [issueDate, setIssueDate] = useState(existing?.issueDate ?? today());
  const [dueDate, setDueDate] = useState(existing && isCharge ? existing.dueDate : '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((x, i) => ({ key: i + 1, accountId: x.accountId, description: x.description ?? '', quantity: x.quantity, unitPrice: x.unitPrice, taxRateId: x.taxRateId ?? '' }))
      : [blank(1)],
  );
  const [newContact, setNewContact] = useState<ContactDraft | null>(null);
  const [override, setOverride] = useState(false);

  const control = new Set([org?.arAccountId, org?.apAccountId, org?.claimsAccountId].filter(Boolean));
  const choices = useMemo(() => {
    const usable = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id));
    const order = [...l.lineTypes, ...TYPE_ORDER.filter((t) => !l.lineTypes.includes(t))];
    return order.map((t) => ({ type: t, items: usable.filter((a) => a.type === t) })).filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data, org?.arAccountId, org?.apAccountId, l]);
  const taxMap = useMemo(
    () => new Map<string, TaxRateInfo>((taxRates.data ?? []).map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate, accountId: l.ledger === 'SALES' ? t.salesAccountId : t.purchaseAccountId }])),
    [taxRates.data, l.ledger],
  );
  const selectedContact = contacts.data?.find((x) => x.id === contact);
  const defaultDue = selectedContact && issueDate ? addDays(issueDate, selectedContact.paymentTermsDays) : '';

  const filled = lines.filter((x) => x.accountId || x.unitPrice || x.description);
  const payloadLines = filled.map((x) => ({ accountId: x.accountId, description: x.description || undefined, quantity: x.quantity || '0', unitPrice: x.unitPrice || '0', taxRateId: x.taxRateId || null }));

  // Same calculation the server runs, so the totals shown are the totals that post.
  const calc = useMemo(() => {
    const issues: string[] = [];
    if (!contact) issues.push(`Choose a ${l.contact.toLowerCase()}`);
    payloadLines.forEach((x, i) => !x.accountId && issues.push(`Line ${i + 1}: choose an account`));
    try {
      const d = computeDocument(payloadLines, c, taxMap);
      return { ok: issues.length === 0, issues, lines: d.lines, subtotal: d.subtotal.toFixed(2), tax: d.taxTotal.toFixed(2), total: d.total.toFixed(2) };
    } catch (e) {
      return { ok: false, issues: [...issues, ...(e instanceof DocumentValidationError ? e.issues : [(e as Error).message])], lines: [], subtotal: null, tax: null, total: null };
    }
  }, [payloadLines, c, taxMap, contact, l.contact]);

  const save = useMutation({
    mutationFn: (post: boolean) => {
      const body = { kind, contactId: contact, issueDate, dueDate: isCharge && dueDate ? dueDate : undefined, reference: reference || null, memo: memo || null, lines: payloadLines };
      const base = `/v1/orgs/${orgId}/${l.api}/documents`;
      return existing
        ? api<FinancialDocument>(`${base}/${existing.id}`, { method: 'PUT', body }).then((d) => (post ? api<FinancialDocument>(`${base}/${d.id}/post`, { method: 'POST', body: { overrideCreditLimit: override } }) : d))
        : api<FinancialDocument>(base, { method: 'POST', body: { ...body, post, overrideCreditLimit: override || undefined } });
    },
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ['documents', orgId] });
      await qc.invalidateQueries({ queryKey: ['document', orgId] });
      await qc.invalidateQueries({ queryKey: ['contacts', orgId] });
      await qc.invalidateQueries({ queryKey: ['dashboard', orgId] });
      router.push(`/orgs/${orgId}/${l.docsPath}/${d.id}`);
    },
  });
  const creditLimitHit = save.error instanceof ApiError && save.error.code === 'CREDIT_LIMIT_EXCEEDED';
  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  if (!org) return null;
  const taxes = taxRates.data ?? [];
  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-6">
      <Card className="grid gap-4 p-5 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="doc-contact" className="text-xs font-medium uppercase tracking-wide text-fg-muted">{l.contact}</label>
          <div className="flex gap-2">
            <Select id="doc-contact" value={contact} onChange={(e) => setContact(e.target.value)}>
              <option value="">Choose a {l.contact.toLowerCase()}…</option>
              {(contacts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
            {can(org.role, 'contacts.manage') ? <Button type="button" variant="secondary" onClick={() => setNewContact(draftFrom(null, l))}>New</Button> : null}
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          {label} date
          <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        </label>
        {isCharge ? (
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Due date
            <Input type="date" value={dueDate} min={issueDate} placeholder={defaultDue} onChange={(e) => setDueDate(e.target.value)} />
            {!dueDate && defaultDue ? <span className="normal-case tracking-normal text-fg-faint">Defaults to {defaultDue} ({selectedContact?.paymentTermsDays} day terms)</span> : null}
          </label>
        ) : <div />}
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted sm:col-span-2">
          {l.reference}
          <Input value={reference} maxLength={100} placeholder="Optional" onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted sm:col-span-2">
          Memo
          <Input value={memo} maxLength={1000} placeholder="Optional note" onChange={(e) => setMemo(e.target.value)} />
        </label>
      </Card>

      <Card>
        <CardHeader title="Lines" description={`Amounts in ${c}. Tax is worked out per line and rounded to the currency.${taxes.length === 0 ? ' No tax rates are set up yet (Settings → Tax rates).' : ''}`} />
        <Table>
          <thead>
            <tr>
              <Th className="w-[26%]">Account</Th>
              <Th>Description</Th>
              <Th numeric className="w-24">Qty</Th>
              <Th numeric className="w-36">Unit price</Th>
              <Th className="w-44">Tax</Th>
              <Th numeric>Amount</Th>
              <Th><span className="sr-only">Remove</span></Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((x, idx) => {
              const pos = filled.indexOf(x);
              const computed = pos >= 0 ? calc.lines[pos] : undefined;
              return (
                <tr key={x.key} className="align-top">
                  <Td>
                    <label className="sr-only" htmlFor={`dl-acc-${x.key}`}>Account for line {idx + 1}</label>
                    <Select id={`dl-acc-${x.key}`} value={x.accountId} onChange={(e) => update(x.key, { accountId: e.target.value })}>
                      <option value="">Select account…</option>
                      {choices.map((g) => (
                        <optgroup key={g.type} label={g.type.charAt(0) + g.type.slice(1).toLowerCase()}>
                          {g.items.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                  </Td>
                  <Td><Input aria-label={`Description for line ${idx + 1}`} value={x.description} maxLength={500} onChange={(e) => update(x.key, { description: e.target.value })} /></Td>
                  <Td numeric><Input aria-label={`Quantity for line ${idx + 1}`} className="num text-right" inputMode="decimal" value={x.quantity} onChange={(e) => QTY.test(e.target.value) && update(x.key, { quantity: e.target.value })} /></Td>
                  <Td numeric><Input aria-label={`Unit price for line ${idx + 1}`} className="num text-right" inputMode="decimal" placeholder="0.00" value={x.unitPrice} onChange={(e) => QTY.test(e.target.value) && update(x.key, { unitPrice: e.target.value })} /></Td>
                  <Td>
                    <Select aria-label={`Tax for line ${idx + 1}`} value={x.taxRateId} onChange={(e) => update(x.key, { taxRateId: e.target.value })}>
                      <option value="">No tax</option>
                      {taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  </Td>
                  <Td numeric className="whitespace-nowrap">
                    {computed ? (
                      <>
                        <span className="num">{money(computed.netAmount.toFixed(2), c)}</span>
                        {computed.taxAmount.gt(0) ? <p className="text-xs text-fg-muted">+ tax {money(computed.taxAmount.toFixed(2), c)}</p> : null}
                      </>
                    ) : <span className="text-fg-faint">—</span>}
                  </Td>
                  <Td>
                    <Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${idx + 1}`} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((y) => y.key !== x.key))}>✕</Button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={4}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(nextKey.current++)])}>+ Add line</Button>
              </Td>
              <Td className="text-right text-sm text-fg-muted">
                <p>Subtotal</p>
                <p>Tax</p>
                <p className="font-semibold text-fg">Total</p>
              </Td>
              <Td numeric className="text-sm">
                <p className="num">{money(calc.subtotal, c)}</p>
                <p className="num">{money(calc.tax, c)}</p>
                <p className="num font-semibold">{money(calc.total, c)}</p>
              </Td>
              <Td />
            </tr>
          </tfoot>
        </Table>
        {calc.issues.length ? (
          <ul className="list-inside list-disc border-t border-line px-5 py-3 text-sm text-warning" aria-live="polite">
            {calc.issues.slice(0, 4).map((i) => <li key={i}>{i}</li>)}
          </ul>
        ) : null}
      </Card>

      {save.error && !creditLimitHit ? (
        <Alert title={`The server rejected this ${label.toLowerCase()}`}>
          {save.error.message}
          {save.error instanceof ApiError && save.error.issues.length ? (
            <ul className="mt-1 list-inside list-disc">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          ) : null}
        </Alert>
      ) : null}
      {creditLimitHit ? (
        <Alert tone="warning" title="Over the credit limit">
          {save.error?.message}. You can save it as a draft, or post it anyway. The override is recorded in the audit trail.
          <label className="mt-2 flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Post above the credit limit</label>
        </Alert>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="button" variant="secondary" loading={save.isPending && save.variables === false} disabled={!calc.ok || save.isPending} onClick={() => save.mutate(false)}>Save as draft</Button>
        {can(org.role, 'journals.post') ? (
          <Button type="button" loading={save.isPending && save.variables === true} disabled={!calc.ok || save.isPending || (creditLimitHit && !override)} onClick={() => save.mutate(true)}>
            {existing ? 'Save and post' : `Post ${label.toLowerCase()}`}
          </Button>
        ) : null}
      </div>
      <ContactDialog l={l} draft={newContact} setDraft={setNewContact} onSaved={(x) => setContact(x.id)} />
    </form>
  );
}
