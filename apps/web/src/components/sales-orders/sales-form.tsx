'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, computeDocument, DocumentValidationError, type TaxRateInfo } from '@talk2tax/accounting-engine';
import { gstHeads, gstSplitter, hsnIssue, placeOfSupplyName, supplyNature, type GstCategory } from '@talk2tax/tax-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Textarea, Th } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { DealList } from '@/lib/crm';
import { money, today } from '@/lib/format';
import { useAccounts, useContacts, useGstRegistration, useGstStates, useOrg, useTaxRates } from '@/lib/org';
import type { AccountType } from '@/lib/types';
import { CONTRACT_FREQUENCIES, FREQUENCY_LABEL, FREQUENCY_MONTHS, type ContractFrequency } from '@talk2tax/accounting-engine';
import type { ContractDetail, QuoteDetail, SalesLineInput } from '@/lib/sales-orders';

interface LineState { key: number; accountId: string; description: string; quantity: string; unitPrice: string; taxRateId: string; hsnCode: string }

const QTY = /^\d{0,12}(\.\d{0,6})?$/;
const TYPE_ORDER: AccountType[] = ['REVENUE', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'];

/**
 * The form for a quotation (mode "quote") or a sales order entered directly (mode "order").
 * Totals are worked out with the same engine and GST split the server uses for invoices, so what is
 * shown is what is saved; the server checks everything again.
 */
type Mode = 'quote' | 'order' | 'contract';
const LABEL: Record<Mode, string> = { quote: 'quotation', order: 'order', contract: 'contract' };

export function SalesForm({ mode, existing, contract, contactId, dealId }: { mode: Mode; existing?: QuoteDetail; contract?: ContractDetail; contactId?: string; dealId?: string }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const contacts = useContacts('customer');
  const taxRates = useTaxRates();
  const gstReg = useGstRegistration();
  const states = useGstStates();
  const router = useRouter();
  const qc = useQueryClient();
  const deals = useQuery({ queryKey: ['crm-deals', orgId, 'open', ''], queryFn: () => api<DealList>(`/v1/orgs/${orgId}/crm/deals?view=open`) });
  const c = org?.functionalCurrency ?? 'INR';
  const prior = existing ?? contract;
  const nextKey = useRef(prior ? prior.lines.length + 1 : 2);
  // Once a contract is active its customer, start date and schedule are fixed.
  const fixed = !!contract && contract.status !== 'DRAFT';
  const blank = (key: number): LineState => ({ key, accountId: '', description: '', quantity: '1', unitPrice: '', taxRateId: '', hsnCode: '' });

  const [contact, setContact] = useState(prior?.contact?.id ?? contactId ?? '');
  const [deal, setDeal] = useState(prior?.deal?.id ?? dealId ?? '');
  const [date, setDate] = useState(existing?.issueDate ?? contract?.startDate ?? today());
  const [validUntil, setValidUntil] = useState(existing?.validUntil ?? addDays(today(), 30));
  const [reference, setReference] = useState(prior?.customerReference ?? '');
  const [title, setTitle] = useState(contract?.title ?? '');
  const [frequency, setFrequency] = useState<ContractFrequency>(contract?.frequency ?? 'MONTHLY');
  const [timing, setTiming] = useState<'ADVANCE' | 'ARREARS'>(contract?.timing ?? 'ADVANCE');
  const [rolling, setRolling] = useState(contract ? !contract.endDate : false);
  const [endDate, setEndDate] = useState(contract?.endDate ?? '');
  const [autoRenew, setAutoRenew] = useState(contract?.autoRenew ?? false);
  const [renewalMonths, setRenewalMonths] = useState(String(contract?.renewalMonths ?? 12));
  const [noticeDays, setNoticeDays] = useState(String(contract?.noticeDays ?? 30));
  const [termsDays, setTermsDays] = useState(contract?.paymentTermsDays === null || contract?.paymentTermsDays === undefined ? '' : String(contract.paymentTermsDays));
  const [terms, setTerms] = useState(existing?.terms ?? '');
  const [memo, setMemo] = useState(prior?.memo ?? '');
  const [placeOfSupply, setPlaceOfSupply] = useState(prior?.placeOfSupply ?? '');
  const [lines, setLines] = useState<LineState[]>(
    prior
      ? prior.lines.map((x, i) => ({ key: i + 1, accountId: x.account?.id ?? '', description: x.description ?? '', quantity: x.quantity, unitPrice: x.unitPrice, taxRateId: x.tax?.id ?? '', hsnCode: x.hsnCode ?? '' }))
      : [blank(1)],
  );

  const control = new Set([org?.arAccountId, org?.apAccountId, org?.claimsAccountId].filter(Boolean));
  const choices = useMemo(() => {
    const usable = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id));
    return TYPE_ORDER.map((t) => ({ type: t, items: usable.filter((a) => a.type === t) })).filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data, org?.arAccountId, org?.apAccountId]);
  const taxMap = useMemo(() => new Map<string, TaxRateInfo>((taxRates.data ?? []).map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate, accountId: t.salesAccountId, kind: t.kind }])), [taxRates.data]);
  const selected = contacts.data?.find((x) => x.id === contact);
  const customerDeals = (deals.data?.deals ?? []).filter((d) => d.contact?.id === contact);

  // India GST on the quotation's date, exactly as on an invoice.
  const reg = gstReg.data?.registered ? gstReg.data : null;
  const gstMode = !!reg && !!date && date >= reg.effectiveFrom;
  const pos = placeOfSupply || (reg ? (selected?.stateCode ?? '') : '');
  const nature = reg && pos ? supplyNature(reg.stateCode, pos) : null;
  const gstCategories = useMemo(() => new Map((taxRates.data ?? []).filter((t) => t.kind === 'GST').map((t) => [t.id, t.gstCategory as GstCategory])), [taxRates.data]);
  const splitter = useMemo(() => (gstMode && nature ? gstSplitter({ nature, stateCode: pos, accounts: { cgst: 'cgst', sgst: 'sgst', igst: 'igst' }, categories: gstCategories }) : undefined), [gstMode, nature, pos, gstCategories]);

  const filled = lines.filter((x) => x.accountId || x.unitPrice || x.description);
  const payload: SalesLineInput[] = filled.map((x) => ({ accountId: x.accountId, description: x.description || null, quantity: x.quantity || '0', unitPrice: x.unitPrice || '0', taxRateId: x.taxRateId || null, hsnCode: x.hsnCode.trim() || null }));

  const calc = useMemo(() => {
    const issues: string[] = [];
    if (!contact) issues.push('Choose the customer');
    if (mode === 'quote' && validUntil && date && validUntil < date) issues.push('Valid until cannot be before the quotation date');
    if (mode === 'contract') {
      if (!title.trim()) issues.push('Give the contract a title');
      if (!rolling && !endDate) issues.push('Give an end date, or make it rolling');
      if (!rolling && endDate && date && endDate < date) issues.push('The end date cannot be before the start date');
      if (autoRenew && !rolling && (Number(renewalMonths) % FREQUENCY_MONTHS[frequency] !== 0 || Number(renewalMonths) < FREQUENCY_MONTHS[frequency])) issues.push(`Renew for a whole number of ${FREQUENCY_LABEL[frequency].toLowerCase()} periods (${FREQUENCY_MONTHS[frequency]} months each)`);
    }
    payload.forEach((x, i) => !x.accountId && issues.push(`Line ${i + 1}: choose an income account`));
    if (gstMode) {
      if (contact && !pos) issues.push(`Choose the place of supply: ${selected?.name ?? 'this customer'} has no state on file`);
      payload.forEach((x, i) => {
        if (!x.taxRateId || !gstCategories.has(x.taxRateId)) issues.push(`Line ${i + 1}: choose a GST rate`);
        else if (gstCategories.get(x.taxRateId) !== 'NON_GST') {
          const h = hsnIssue(x.hsnCode ?? '');
          if (h) issues.push(`Line ${i + 1}: ${h}`);
        }
      });
    }
    try {
      const d = computeDocument(payload.map((x) => ({ ...x, description: x.description ?? undefined })), c, taxMap, splitter);
      return { ok: issues.length === 0, issues, lines: d.lines, subtotal: d.subtotal.toFixed(2), tax: d.taxTotal.toFixed(2), total: d.total.toFixed(2), heads: gstHeads(d.lines.flatMap((x) => x.taxComponents)) };
    } catch (e) {
      return { ok: false, issues: [...issues, ...(e instanceof DocumentValidationError ? e.issues : [(e as Error).message])], lines: [], subtotal: null, tax: null, total: null, heads: null };
    }
  }, [payload, c, taxMap, contact, mode, validUntil, date, gstMode, pos, selected, gstCategories, splitter, title, rolling, endDate, autoRenew, renewalMonths, frequency]);

  const save = useMutation({
    mutationFn: () => {
      const common = { contactId: contact, dealId: deal || null, placeOfSupply: gstMode ? pos || null : null, reference: reference || null, memo: memo || null, lines: payload };
      const base = `/v1/orgs/${orgId}/sales`;
      if (mode === 'order') return api<{ id: string }>(`${base}/orders`, { method: 'POST', body: { ...common, orderDate: date } });
      if (mode === 'contract') {
        const body = {
          ...common,
          title: title.trim(),
          frequency,
          timing,
          startDate: date,
          endDate: rolling ? null : endDate,
          autoRenew: !rolling && autoRenew,
          renewalMonths: !rolling && autoRenew ? Number(renewalMonths) : null,
          noticeDays: Number(noticeDays || '0'),
          paymentTermsDays: termsDays === '' ? null : Number(termsDays),
        };
        return contract ? api<{ id: string }>(`${base}/contracts/${contract.id}`, { method: 'PUT', body }) : api<{ id: string }>(`${base}/contracts`, { method: 'POST', body });
      }
      const body = { ...common, issueDate: date, validUntil, terms: terms || null };
      return existing ? api<{ id: string }>(`${base}/quotes/${existing.id}`, { method: 'PUT', body }) : api<{ id: string }>(`${base}/quotes`, { method: 'POST', body });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['sales-quotes', orgId] });
      await qc.invalidateQueries({ queryKey: ['sales-quote', orgId] });
      await qc.invalidateQueries({ queryKey: ['sales-orders', orgId] });
      await qc.invalidateQueries({ queryKey: ['sales-contracts', orgId] });
      await qc.invalidateQueries({ queryKey: ['sales-contract', orgId] });
      await qc.invalidateQueries({ queryKey: ['crm-deals', orgId] });
      await qc.invalidateQueries({ queryKey: ['crm-deal', orgId] });
      router.push(`/orgs/${orgId}/sales/${mode === 'quote' ? 'quotes' : mode === 'order' ? 'orders' : 'contracts'}/${r.id}`);
    },
  });
  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  if (!org) return null;
  const taxes = (taxRates.data ?? []).filter((t) => (gstMode ? t.kind === 'GST' : t.kind !== 'GST'));
  const stateLabel = pos ? (states.data?.find((x) => x.code === pos)?.levies ?? 'SGST') : 'SGST';
  const field = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';
  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-6">
      <Card className="grid gap-4 p-5 sm:grid-cols-4">
        <label className={`${field} sm:col-span-2`}>
          Customer
          <Select aria-label="Customer" disabled={fixed} value={contact} onChange={(e) => { setContact(e.target.value); setDeal(''); }}>
            <option value="">Choose a customer…</option>
            {(contacts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </label>
        <label className={field}>
          {mode === 'quote' ? 'Quotation date' : mode === 'order' ? 'Order date' : 'Start date'}
          <Input aria-label={mode === 'quote' ? 'Quotation date' : mode === 'order' ? 'Order date' : 'Start date'} type="date" disabled={fixed} value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        {mode === 'quote' ? (
          <label className={field}>
            Valid until
            <Input aria-label="Valid until" type="date" value={validUntil} min={date} onChange={(e) => setValidUntil(e.target.value)} required />
          </label>
        ) : mode === 'contract' ? (
          <div className={field}>
            <label htmlFor="contract-end">End date</label>
            <Input id="contract-end" aria-label="End date" type="date" value={rolling ? '' : endDate} min={date} disabled={rolling} onChange={(e) => setEndDate(e.target.value)} />
            <label className="flex items-center gap-1.5 normal-case tracking-normal text-fg-muted">
              <input type="checkbox" className="accent-[var(--t2t-accent)]" checked={rolling} onChange={(e) => setRolling(e.target.checked)} /> Rolling (no end date)
            </label>
          </div>
        ) : <div />}
        {mode === 'contract' ? (
          <div className="grid gap-4 sm:col-span-4 sm:grid-cols-4">
            <label className={`${field} sm:col-span-2`}>
              Title
              <Input aria-label="Title" value={title} maxLength={200} placeholder="Monthly bookkeeping and GST returns" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className={field}>
              Billed
              <Select aria-label="Billed" disabled={fixed} value={frequency} onChange={(e) => setFrequency(e.target.value as ContractFrequency)}>
                {CONTRACT_FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
              </Select>
            </label>
            <label className={field}>
              Invoice dated
              <Select aria-label="Invoice dated" disabled={fixed} value={timing} onChange={(e) => setTiming(e.target.value as 'ADVANCE' | 'ARREARS')}>
                <option value="ADVANCE">In advance (first day)</option>
                <option value="ARREARS">In arrears (last day)</option>
              </Select>
            </label>
            <label className={field}>
              Payment terms (days)
              <Input aria-label="Payment terms (days)" inputMode="numeric" className="num" value={termsDays} placeholder="Customer's terms" onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setTermsDays(e.target.value)} />
            </label>
            <label className={field}>
              Renewal notice (days)
              <Input aria-label="Renewal notice (days)" inputMode="numeric" className="num" value={noticeDays} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setNoticeDays(e.target.value)} />
            </label>
            <div className={`${field} sm:col-span-2`}>
              Auto-renew
              <span className="flex items-center gap-2 normal-case tracking-normal text-fg">
                <input aria-label="Auto-renew" type="checkbox" className="accent-[var(--t2t-accent)]" disabled={rolling} checked={!rolling && autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
                for
                <Input aria-label="Renewal term (months)" inputMode="numeric" className="num w-20" disabled={rolling || !autoRenew} value={renewalMonths} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setRenewalMonths(e.target.value)} />
                months at the end date
              </span>
            </div>
          </div>
        ) : null}
        <label className={`${field} sm:col-span-2`}>
          Deal
          <Select aria-label="Deal" value={deal} onChange={(e) => setDeal(e.target.value)} disabled={!contact}>
            <option value="">No deal</option>
            {customerDeals.map((d) => <option key={d.id} value={d.id}>{d.reference} {d.name}</option>)}
            {prior?.deal && !customerDeals.some((d) => d.id === prior.deal!.id) ? <option value={prior.deal.id}>{prior.deal.reference} {prior.deal.name}</option> : null}
          </Select>
          <span className="normal-case tracking-normal text-fg-faint">{mode === 'quote' ? 'Accepting the quotation marks this deal won.' : mode === 'order' ? 'Saving the order marks this deal won.' : 'Activating the contract marks this deal won.'}</span>
        </label>
        <label className={`${field} sm:col-span-2`}>
          {mode === 'order' ? 'Customer PO number' : 'Customer reference'}
          <Input aria-label={mode === 'order' ? 'Customer PO number' : 'Customer reference'} value={reference} maxLength={100} placeholder="Optional" onChange={(e) => setReference(e.target.value)} />
        </label>
        {mode === 'quote' ? (
          <label className={`${field} sm:col-span-4`}>
            Terms
            <Textarea aria-label="Terms" rows={3} value={terms} maxLength={4000} placeholder="Payment terms, delivery, what is included" onChange={(e) => setTerms(e.target.value)} />
          </label>
        ) : null}
        <label className={`${field} sm:col-span-4`}>
          Memo
          <Input aria-label="Memo" value={memo} maxLength={1000} placeholder="Internal note (optional)" onChange={(e) => setMemo(e.target.value)} />
        </label>
        {gstMode ? (
          <div className="grid gap-4 rounded-lg border border-line bg-surface-raised p-4 sm:col-span-4 sm:grid-cols-4" aria-label="GST">
            <label className={`${field} sm:col-span-2`}>
              Place of supply
              <Select aria-label="Place of supply" value={pos} onChange={(e) => setPlaceOfSupply(e.target.value)}>
                <option value="">Choose a state…</option>
                {(states.data ?? []).map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
              </Select>
              <span className="normal-case tracking-normal text-fg-faint">{selected?.stateCode ? `Defaults to the customer's state (${placeOfSupplyName(selected.stateCode)}).` : 'The customer has no state; choose where the supply is made.'}</span>
            </label>
            <div className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">GST treatment</span>
              {nature ? (
                <p className="font-medium">{nature === 'INTRA' ? `Intra-state: CGST + ${stateLabel}` : pos === '96' ? 'Export: IGST (with payment)' : 'Inter-state: IGST'}</p>
              ) : <p className="text-fg-faint">Choose the customer and place of supply.</p>}
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title={mode === 'contract' ? 'Lines billed each period' : 'Lines'} description={`Amounts in ${c}${mode === 'contract' ? ', per period' : ''}. Tax is worked out per line exactly as on an invoice.${taxes.length === 0 ? ' No tax rates are set up yet.' : ''}`} />
        <Table>
          <thead>
            <tr>
              <Th className="w-[26%]">Account</Th>
              <Th>Description</Th>
              <Th numeric className="w-24">Qty</Th>
              <Th numeric className="w-36">Unit price</Th>
              {gstMode ? <Th className="w-28">HSN/SAC</Th> : null}
              <Th className="w-44">{gstMode ? 'GST rate' : 'Tax'}</Th>
              <Th numeric>Amount</Th>
              <Th><span className="sr-only">Remove</span></Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((x, idx) => {
              const at = filled.indexOf(x);
              const computed = at >= 0 ? calc.lines[at] : undefined;
              return (
                <tr key={x.key} className="align-top">
                  <Td>
                    <Select aria-label={`Account for line ${idx + 1}`} value={x.accountId} onChange={(e) => update(x.key, { accountId: e.target.value })}>
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
                  {gstMode ? <Td><Input aria-label={`HSN or SAC for line ${idx + 1}`} className="num" inputMode="numeric" maxLength={8} placeholder="998221" value={x.hsnCode} onChange={(e) => /^\d{0,8}$/.test(e.target.value) && update(x.key, { hsnCode: e.target.value })} /></Td> : null}
                  <Td>
                    <Select aria-label={`Tax for line ${idx + 1}`} value={x.taxRateId} onChange={(e) => update(x.key, { taxRateId: e.target.value })}>
                      <option value="">{gstMode ? 'Choose…' : 'No tax'}</option>
                      {taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  </Td>
                  <Td numeric className="whitespace-nowrap">
                    {computed ? (
                      <>
                        <span className="num">{money(computed.netAmount.toFixed(2), c)}</span>
                        {computed.taxComponents.map((tc) => <p key={tc.code} className="text-xs text-fg-muted">+ {tc.code === 'TAX' ? 'tax' : `${tc.code} ${tc.rate.toFixed()}%`} {money(tc.amount.toFixed(2), c)}</p>)}
                      </>
                    ) : <span className="text-fg-faint">—</span>}
                  </Td>
                  <Td><Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${idx + 1}`} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((y) => y.key !== x.key))}>✕</Button></Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={gstMode ? 4 : 3}><Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(nextKey.current++)])}>+ Add line</Button></Td>
              <Td colSpan={2} className="whitespace-nowrap text-right text-sm text-fg-muted">
                <p>{gstMode ? 'Taxable value' : 'Subtotal'}</p>
                {gstMode && calc.heads ? (nature === 'INTRA' ? <><p>CGST</p><p>{stateLabel}</p></> : <p>IGST</p>) : <p>Tax</p>}
                <p className="font-semibold text-fg">Total</p>
              </Td>
              <Td numeric className="text-sm">
                <p className="num">{money(calc.subtotal, c)}</p>
                {gstMode && calc.heads ? (nature === 'INTRA' ? <><p className="num">{money(calc.heads.cgst.toFixed(2), c)}</p><p className="num">{money(calc.heads.sgst.toFixed(2), c)}</p></> : <p className="num">{money(calc.heads.igst.toFixed(2), c)}</p>) : <p className="num">{money(calc.tax, c)}</p>}
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

      {save.error ? (
        <Alert title={`The server rejected this ${LABEL[mode]}`}>
          {save.error.message}
          {save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-inside list-disc">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </Alert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="button" loading={save.isPending} disabled={!calc.ok || save.isPending} onClick={() => save.mutate()}>
          {mode === 'order' ? 'Save order' : prior ? 'Save changes' : mode === 'contract' ? 'Save draft contract' : 'Save draft quotation'}
        </Button>
      </div>
    </form>
  );
}
