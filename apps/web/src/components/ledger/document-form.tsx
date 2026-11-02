'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, applyReverseCharge, computeDocument, DocumentValidationError, type TaxRateInfo } from '@talk2tax/accounting-engine';
import { gstHeads, gstSplitter, hsnIssue, placeOfSupplyName, supplyNature, type GstCategory } from '@talk2tax/tax-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { money, today } from '@/lib/format';
import type { LedgerConfig } from '@/lib/ledgers';
import { useAccounts, useContacts, useGstRegistration, useGstStates, useOrg, useTaxRates, useWithholdingSections, useWithholdingSettings } from '@/lib/org';
import { can, type AccountType, type DocumentKind, type FinancialDocument, type WithholdingPreview } from '@/lib/types';
import { LineDimensions } from '@/components/dimensions/line-dimensions';
import { useDimensions } from '@/lib/dimensions';
import { ContactDialog, draftFrom, type ContactDraft } from './contacts-page';

interface LineState {
  key: number;
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRateId: string;
  hsnCode: string;
  departmentId: string;
  projectId: string;
}

const QTY = /^\d{0,12}(\.\d{0,6})?$/;
const TYPE_ORDER: AccountType[] = ['REVENUE', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'];
/** Reverse charge in the form: input-tax placeholders pair with output-tax placeholders. */
const RCM_ACCOUNTS = new Map([['cgst', 'out-cgst'], ['sgst', 'out-sgst'], ['igst', 'out-igst']]);

export function DocumentForm({ l, kind, existing, contactId }: { l: LedgerConfig; kind: DocumentKind; existing?: FinancialDocument; contactId?: string }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const dims = useDimensions();
  const contacts = useContacts(l.contactRole);
  const taxRates = useTaxRates();
  const gstReg = useGstRegistration();
  const states = useGstStates();
  const wSettings = useWithholdingSettings();
  const wSections = useWithholdingSections();
  const router = useRouter();
  const qc = useQueryClient();
  const c = org?.functionalCurrency ?? 'INR';
  const nextKey = useRef(2);
  const blank = (key: number): LineState => ({ key, accountId: '', description: '', quantity: '1', unitPrice: '', taxRateId: '', hsnCode: '', departmentId: '', projectId: '' });
  const isCharge = kind === l.charge.kind;
  const label = isCharge ? l.charge.label : l.credit.label;

  const [contact, setContact] = useState(existing?.contact.id ?? contactId ?? '');
  const [issueDate, setIssueDate] = useState(existing?.issueDate ?? today());
  const [dueDate, setDueDate] = useState(existing && isCharge ? existing.dueDate : '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((x, i) => ({ key: i + 1, accountId: x.accountId, description: x.description ?? '', quantity: x.quantity, unitPrice: x.unitPrice, taxRateId: x.taxRateId ?? '', hsnCode: x.hsnCode ?? '', departmentId: x.departmentId ?? '', projectId: x.projectId ?? '' }))
      : [blank(1)],
  );
  const [placeOfSupply, setPlaceOfSupply] = useState(existing?.gst?.placeOfSupply ?? '');
  const [reverseCharge, setReverseCharge] = useState(existing?.reverseCharge ?? false);
  const [sectionId, setSectionId] = useState(existing?.withholding?.section.id ?? (contactId ? '' : ''));
  const [sectionTouched, setSectionTouched] = useState(!!existing);
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
    () => new Map<string, TaxRateInfo>((taxRates.data ?? []).map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate, accountId: l.ledger === 'SALES' ? t.salesAccountId : t.purchaseAccountId, kind: t.kind }])),
    [taxRates.data, l.ledger],
  );
  const selectedContact = contacts.data?.find((x) => x.id === contact);
  // TDS on bills, TCS on invoices; the contact's default section applies until one is chosen here.
  const wKind = kind === 'BILL' ? 'TDS' : kind === 'INVOICE' ? 'TCS' : null;
  const wOptions = wKind && wSettings.data?.configured ? (wSections.data ?? []).filter((x) => x.kind === wKind) : [];
  const defaultSection = !sectionTouched && selectedContact?.withholdingSectionId && wOptions.some((x) => x.id === selectedContact.withholdingSectionId) ? selectedContact.withholdingSectionId : '';
  const section = sectionTouched ? sectionId : defaultSection;

  // India GST: from the registration's effective date every line uses a GST rate, split by place of supply.
  const reg = gstReg.data?.registered ? gstReg.data : null;
  const gstMode = !!reg && !!issueDate && issueDate >= reg.effectiveFrom;
  const supplierState = !reg ? null : l.ledger === 'SALES' ? reg.stateCode : (selectedContact?.stateCode ?? null);
  const defaultPos = !reg ? '' : l.ledger === 'SALES' ? (selectedContact?.stateCode ?? '') : reg.stateCode;
  const pos = placeOfSupply || defaultPos;
  const nature = supplierState && pos ? supplyNature(supplierState, pos) : null;
  const gstCategories = useMemo(() => new Map((taxRates.data ?? []).filter((t) => t.kind === 'GST').map((t) => [t.id, t.gstCategory as GstCategory])), [taxRates.data]);
  const splitter = useMemo(
    () => (gstMode && nature ? gstSplitter({ nature, stateCode: pos, accounts: { cgst: 'cgst', sgst: 'sgst', igst: 'igst' }, categories: gstCategories }) : undefined),
    [gstMode, nature, pos, gstCategories],
  );
  const defaultDue = selectedContact && issueDate ? addDays(issueDate, selectedContact.paymentTermsDays) : '';

  const filled = lines.filter((x) => x.accountId || x.unitPrice || x.description);
  const payloadLines = filled.map((x) => ({ accountId: x.accountId, description: x.description || undefined, quantity: x.quantity || '0', unitPrice: x.unitPrice || '0', taxRateId: x.taxRateId || null, hsnCode: x.hsnCode.trim() || null, departmentId: x.departmentId || null, projectId: x.projectId || null }));

  // Same calculation the server runs, so the totals shown are the totals that post.
  const calc = useMemo(() => {
    const issues: string[] = [];
    if (!contact) issues.push(`Choose a ${l.contact.toLowerCase()}`);
    payloadLines.forEach((x, i) => !x.accountId && issues.push(`Line ${i + 1}: choose an account`));
    if (gstMode) {
      if (contact && !pos) issues.push(`Choose the place of supply: ${selectedContact?.name ?? 'this contact'} has no state on file`);
      if (contact && !supplierState) issues.push(`Add ${selectedContact?.name ?? 'the vendor'}'s GSTIN or state before entering a GST bill`);
      payloadLines.forEach((x, i) => {
        if (!x.taxRateId || !gstCategories.has(x.taxRateId)) issues.push(`Line ${i + 1}: choose a GST rate`);
        else if (gstCategories.get(x.taxRateId) !== 'NON_GST') {
          const h = hsnIssue(x.hsnCode);
          if (h) issues.push(`Line ${i + 1}: ${h}`);
        }
      });
      const charged = payloadLines.some((x) => x.taxRateId && gstCategories.get(x.taxRateId) === 'TAXABLE' && taxMap.get(x.taxRateId)?.rate !== '0');
      if (l.ledger === 'PURCHASES' && selectedContact && charged && !reverseCharge) {
        if (selectedContact.stateCode === '96') issues.push(`${selectedContact.name} is outside India: services from abroad are under reverse charge (tick Reverse charge)`);
        else if (!selectedContact.gstin) issues.push(`${selectedContact.name} has no GSTIN, so their bill cannot carry GST. Tick Reverse charge if you pay the GST.`);
      }
      if (reverseCharge && !charged && payloadLines.length) issues.push('A reverse-charge document needs at least one line with a GST rate above 0%');
    }
    try {
      let d = computeDocument(payloadLines, c, taxMap, splitter);
      if (gstMode && reverseCharge) d = applyReverseCharge(d, RCM_ACCOUNTS);
      const heads = gstHeads(d.lines.flatMap((x) => x.taxComponents));
      return { ok: issues.length === 0, issues, lines: d.lines, subtotal: d.subtotal.toFixed(2), tax: d.taxTotal.toFixed(2), total: d.total.toFixed(2), rcmTax: d.reverseCharge?.tax.toFixed(2) ?? null, heads };
    } catch (e) {
      return { ok: false, issues: [...issues, ...(e instanceof DocumentValidationError ? e.issues : [(e as Error).message])], lines: [], subtotal: null, tax: null, total: null, rcmTax: null, heads: null };
    }
  }, [payloadLines, c, taxMap, contact, l.contact, l.ledger, gstMode, pos, supplierState, selectedContact, gstCategories, splitter, reverseCharge]);

  // The tax to withhold depends on the contact's posted documents, so the server works it out.
  const wAmount = calc.subtotal === null ? null : wKind === 'TDS' ? calc.subtotal : (Number(calc.subtotal) + Number(calc.tax)).toFixed(2);
  const preview = useQuery({
    queryKey: ['withholding-preview', orgId, contact, section, issueDate, wAmount, existing?.id],
    enabled: !!section && !!contact && !!issueDate && wAmount !== null && !!wKind,
    queryFn: () => api<WithholdingPreview>(`/v1/orgs/${orgId}/withholding/preview`, { method: 'POST', body: { documentKind: kind, contactId: contact, sectionId: section, issueDate, amount: wAmount, documentId: existing?.id } }),
    retry: false,
  });
  const wTax = section && preview.data ? preview.data.amount : '0.00';
  const settle = calc.total === null ? null : (Number(calc.total) + (wKind === 'TCS' ? 1 : -1) * Number(wTax)).toFixed(2);

  const save = useMutation({
    mutationFn: (post: boolean) => {
      const body = {
        kind,
        contactId: contact,
        issueDate,
        dueDate: isCharge && dueDate ? dueDate : undefined,
        reference: reference || null,
        memo: memo || null,
        placeOfSupply: gstMode ? pos || null : null,
        reverseCharge: gstMode && l.ledger === 'PURCHASES' ? reverseCharge : undefined,
        withholdingSectionId: wKind ? section || null : undefined,
        lines: payloadLines,
      };
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
  const taxes = (taxRates.data ?? []).filter((t) => (gstMode ? t.kind === 'GST' : t.kind !== 'GST' || (!!reg && !issueDate)));
  const stateLabel = pos ? (states.data?.find((x) => x.code === pos)?.levies ?? 'SGST') : 'SGST';
  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-6">
      <Card className="grid gap-4 p-5 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="doc-contact" className="text-xs font-medium uppercase tracking-wide text-fg-muted">{l.contact}</label>
          <div className="flex gap-2">
            <Select id="doc-contact" value={contact} onChange={(e) => { setContact(e.target.value); if (!existing) setSectionTouched(false); }}>
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
        {gstMode ? (
          <div className="grid gap-4 rounded-lg border border-line bg-surface-raised p-4 sm:col-span-4 sm:grid-cols-4" aria-label="GST">
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted sm:col-span-2">
              Place of supply
              <Select value={pos} onChange={(e) => setPlaceOfSupply(e.target.value)}>
                <option value="">Choose a state…</option>
                {(states.data ?? []).filter((x) => l.ledger === 'SALES' || x.code !== '96').map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
              </Select>
              <span className="normal-case tracking-normal text-fg-faint">
                {l.ledger === 'SALES' ? (selectedContact?.stateCode ? `Defaults to the customer's state (${placeOfSupplyName(selectedContact.stateCode)}).` : 'The customer has no state; choose where the supply is made.') : `Defaults to your state (${reg ? placeOfSupplyName(reg.stateCode) : ''}).`}
              </span>
            </label>
            <div className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">GST treatment</span>
              {nature ? (
                <p>
                  <span className="font-medium">{nature === 'INTRA' ? `Intra-state: CGST + ${stateLabel}` : pos === '96' ? 'Export: IGST (with payment)' : 'Inter-state: IGST'}</span>
                  <span className="block text-xs text-fg-muted">
                    Supplier in {supplierState === '96' ? 'outside India' : placeOfSupplyName(supplierState!)}, supply in {placeOfSupplyName(pos)}.
                    {l.ledger === 'SALES' ? (selectedContact ? (selectedContact.gstin ? ` Buyer GSTIN ${selectedContact.gstin}.` : ' Unregistered buyer (B2C).') : '') : selectedContact?.gstin ? ` Supplier GSTIN ${selectedContact.gstin}.` : ''}
                  </span>
                </p>
              ) : <p className="text-fg-faint">Choose the {l.contact.toLowerCase()} and place of supply.</p>}
            </div>
            {l.ledger === 'PURCHASES' ? (
              <label className="flex items-start gap-2 text-sm sm:col-span-4">
                <input type="checkbox" className="mt-0.5 accent-[var(--t2t-accent)]" checked={reverseCharge} onChange={(e) => setReverseCharge(e.target.checked)} />
                <span>
                  <span className="font-medium">Reverse charge</span>
                  <span className="block text-xs text-fg-muted">You pay the GST instead of the supplier (for example legal services, goods transport, or services from abroad). The vendor is owed the amount without GST; the GST posts as a liability you pay in cash and as input tax credit.</span>
                </span>
              </label>
            ) : null}
          </div>
        ) : null}
        {wKind && wOptions.length ? (
          <div className="grid gap-4 rounded-lg border border-line bg-surface-raised p-4 sm:col-span-4 sm:grid-cols-4" aria-label={wKind}>
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted sm:col-span-2">
              {wKind === 'TDS' ? 'TDS section' : 'TCS section'}
              <Select value={section} onChange={(e) => { setSectionTouched(true); setSectionId(e.target.value); }}>
                <option value="">No {wKind}</option>
                {wOptions.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name} ({x.rate}%)</option>)}
              </Select>
              {defaultSection ? <span className="normal-case tracking-normal text-fg-faint">The {l.contact.toLowerCase()}&apos;s default section.</span> : null}
            </label>
            <div className="flex flex-col gap-1 text-sm sm:col-span-2" aria-live="polite">
              <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">{wKind === 'TDS' ? 'Tax to deduct' : 'Tax to collect'}</span>
              {!section ? <p className="text-fg-faint">None.</p> : preview.error ? <p className="text-warning">{(preview.error as Error).message}</p> : preview.data ? (
                <p>
                  <span className="font-medium">{wKind} {preview.data.rate}% on {money(preview.data.base, c)} = {money(preview.data.amount, c)}</span>
                  <span className="block text-xs text-fg-muted">{preview.data.reason ? `${preview.data.reason.charAt(0).toUpperCase()}${preview.data.reason.slice(1)}.` : ''} {preview.data.pan ? `PAN ${preview.data.pan}.` : 'No PAN on file.'}</span>
                </p>
              ) : <p className="text-fg-faint">{contact ? 'Working it out…' : `Choose the ${l.contact.toLowerCase()}.`}</p>}
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Lines" description={`Amounts in ${c}. Tax is worked out per line and rounded to the currency${gstMode ? '; CGST and SGST/UTGST are each rounded on their own' : ''}.${taxes.length === 0 ? (gstMode ? ' No GST rates are set up yet (Tax → Tax rates).' : ' No tax rates are set up yet (Settings → Tax rates).') : ''}`} />
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
                    <LineDimensions values={dims.data?.values} line={idx + 1} departmentId={x.departmentId} projectId={x.projectId} onChange={(p) => update(x.key, p)} />
                  </Td>
                  <Td><Input aria-label={`Description for line ${idx + 1}`} value={x.description} maxLength={500} onChange={(e) => update(x.key, { description: e.target.value })} /></Td>
                  <Td numeric><Input aria-label={`Quantity for line ${idx + 1}`} className="num text-right" inputMode="decimal" value={x.quantity} onChange={(e) => QTY.test(e.target.value) && update(x.key, { quantity: e.target.value })} /></Td>
                  <Td numeric><Input aria-label={`Unit price for line ${idx + 1}`} className="num text-right" inputMode="decimal" placeholder="0.00" value={x.unitPrice} onChange={(e) => QTY.test(e.target.value) && update(x.key, { unitPrice: e.target.value })} /></Td>
                  {gstMode ? (
                    <Td><Input aria-label={`HSN or SAC for line ${idx + 1}`} className="num" inputMode="numeric" maxLength={8} placeholder="8471" value={x.hsnCode} onChange={(e) => /^\d{0,8}$/.test(e.target.value) && update(x.key, { hsnCode: e.target.value })} /></Td>
                  ) : null}
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
                        {computed.taxComponents.length > 1 || (computed.taxComponents[0] && computed.taxComponents[0].code !== 'TAX')
                          ? computed.taxComponents.map((tc) => <p key={tc.code} className="text-xs text-fg-muted">+ {tc.code} {tc.rate.toFixed()}% {money(tc.amount.toFixed(2), c)}</p>)
                          : computed.taxAmount.gt(0) ? <p className="text-xs text-fg-muted">+ tax {money(computed.taxAmount.toFixed(2), c)}</p> : null}
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
              <Td colSpan={gstMode ? 4 : 3}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(nextKey.current++)])}>+ Add line</Button>
              </Td>
              <Td colSpan={2} className="whitespace-nowrap text-right text-sm text-fg-muted">
                <p>{gstMode ? 'Taxable value' : 'Subtotal'}</p>
                {gstMode && calc.heads ? (
                  nature === 'INTRA' ? (<><p>CGST{reverseCharge ? ' (reverse charge)' : ''}</p><p>{stateLabel}{reverseCharge ? ' (reverse charge)' : ''}</p></>) : <p>IGST{reverseCharge ? ' (reverse charge)' : ''}</p>
                ) : <p>Tax</p>}
                <p className="font-semibold text-fg">Total</p>
                {Number(wTax) > 0 ? <><p>{wKind === 'TDS' ? 'Less TDS' : 'Add TCS'}</p><p className="font-semibold text-fg">{wKind === 'TDS' ? 'Payable to vendor' : 'Customer pays'}</p></> : null}
              </Td>
              <Td numeric className="text-sm">
                <p className="num">{money(calc.subtotal, c)}</p>
                {gstMode && calc.heads ? (
                  nature === 'INTRA' ? (<><p className={`num ${reverseCharge ? 'text-fg-muted' : ''}`}>{money(calc.heads.cgst.toFixed(2), c)}</p><p className={`num ${reverseCharge ? 'text-fg-muted' : ''}`}>{money(calc.heads.sgst.toFixed(2), c)}</p></>) : <p className={`num ${reverseCharge ? 'text-fg-muted' : ''}`}>{money(calc.heads.igst.toFixed(2), c)}</p>
                ) : <p className="num">{money(calc.tax, c)}</p>}
                <p className="num font-semibold">{money(calc.total, c)}</p>
                {Number(wTax) > 0 ? <><p className="num">{wKind === 'TDS' ? '−' : '+'} {money(wTax, c)}</p><p className="num font-semibold">{money(settle, c)}</p></> : null}
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
        <Button type="button" variant="secondary" loading={save.isPending && save.variables === false} disabled={!calc.ok || save.isPending || (!!section && !preview.data)} onClick={() => save.mutate(false)}>Save as draft</Button>
        {can(org.role, 'journals.post') ? (
          <Button type="button" loading={save.isPending && save.variables === true} disabled={!calc.ok || save.isPending || (creditLimitHit && !override) || (!!section && !preview.data)} onClick={() => save.mutate(true)}>
            {existing ? 'Save and post' : `Post ${label.toLowerCase()}`}
          </Button>
        ) : null}
      </div>
      <ContactDialog l={l} draft={newContact} setDraft={setNewContact} onSaved={(x) => setContact(x.id)} />
    </form>
  );
}
