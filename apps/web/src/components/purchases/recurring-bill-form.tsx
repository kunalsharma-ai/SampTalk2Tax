'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applyReverseCharge,
  computeDocument,
  DocumentValidationError,
  fillPlaceholders,
  RECURRING_FREQUENCIES,
  RECURRING_FREQUENCY_LABEL,
  recurringReferenceIssue,
  runCount,
  TEMPLATE_PLACEHOLDERS,
  upcomingRuns,
  type RecurringFrequency,
  type TaxRateInfo,
} from '@talk2tax/accounting-engine';
import { gstHeads, gstSplitter, hsnIssue, placeOfSupplyName, supplyNature, type GstCategory } from '@talk2tax/tax-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th, cn } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { LineDimensions } from '@/components/dimensions/line-dimensions';
import { api, ApiError } from '@/lib/api';
import { useDimensions } from '@/lib/dimensions';
import { date as fmtDate, money, today } from '@/lib/format';
import { useAccounts, useContacts, useGstRegistration, useGstStates, useOrg, useTaxRates, useWithholdingSections, useWithholdingSettings } from '@/lib/org';
import type { RecurringBillDetail } from '@/lib/recurring-bills';
import { can, type FinancialDocument } from '@/lib/types';

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
const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';
const RCM_ACCOUNTS = new Map([['cgst', 'out-cgst'], ['sgst', 'out-sgst'], ['igst', 'out-igst']]);

/**
 * Create or edit a recurring bill (AP-005): the vendor, the lines and the schedule. A bill opened
 * with *Make recurring…* fills it from that bill. The totals shown are worked out by the same
 * engine as a bill; the server checks the whole first bill again before saving.
 */
export function RecurringBillForm({ existing, fromBill }: { existing?: RecurringBillDetail; fromBill?: FinancialDocument }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const dims = useDimensions();
  const vendors = useContacts('vendor');
  const taxRates = useTaxRates();
  const gstReg = useGstRegistration();
  const states = useGstStates();
  const wSettings = useWithholdingSettings();
  const wSections = useWithholdingSections();
  const router = useRouter();
  const qc = useQueryClient();
  const c = org?.functionalCurrency ?? 'INR';
  const blank = (key: number): LineState => ({ key, accountId: '', description: '', quantity: '1', unitPrice: '', taxRateId: '', hsnCode: '', departmentId: '', projectId: '' });
  const seedLines = existing?.lines ?? fromBill?.lines;
  const nextKey = useRef((seedLines?.length ?? 1) + 1);

  const [name, setName] = useState(existing?.name ?? (fromBill ? `${fromBill.contact.name} ${fromBill.memo ?? 'bill'}`.slice(0, 120) : ''));
  const [contact, setContact] = useState(existing?.contact.id ?? fromBill?.contact.id ?? '');
  const [reference, setReference] = useState(existing?.vendorReference ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? fromBill?.memo ?? '');
  const [dueDays, setDueDays] = useState(existing?.dueDays != null ? String(existing.dueDays) : '');
  const [placeOfSupply, setPlaceOfSupply] = useState(existing?.placeOfSupply ?? fromBill?.gst?.placeOfSupply ?? '');
  const [reverseCharge, setReverseCharge] = useState(existing?.reverseCharge ?? fromBill?.reverseCharge ?? false);
  const [section, setSection] = useState(existing?.withholdingSectionId ?? fromBill?.withholding?.section.id ?? '');
  const [lines, setLines] = useState<LineState[]>(
    seedLines
      ? seedLines.map((x, i) => ({ key: i + 1, accountId: x.accountId, description: x.description ?? '', quantity: x.quantity, unitPrice: x.unitPrice, taxRateId: x.taxRateId ?? '', hsnCode: x.hsnCode ?? '', departmentId: x.departmentId ?? '', projectId: x.projectId ?? '' }))
      : [blank(1)],
  );
  const ex = existing?.schedule;
  const [frequency, setFrequency] = useState<RecurringFrequency>(ex?.frequency ?? 'MONTHLY');
  const [startDate, setStartDate] = useState(ex?.startDate ?? today());
  const [endDate, setEndDate] = useState(ex?.endDate ?? '');
  const [monthEnd, setMonthEnd] = useState(ex?.monthEnd ?? false);
  const [postMode, setPostMode] = useState<'DRAFT' | 'POST'>(ex?.postMode ?? 'DRAFT');
  const ran = !!ex && ex.nextRunNo > 1;
  const fy = org?.fiscalYearStartMonth ?? 4;

  const control = new Set([org?.arAccountId, org?.apAccountId, org?.claimsAccountId].filter(Boolean));
  const choices = useMemo(() => {
    const usable = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id));
    return (['EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE'] as const).map((t) => ({ type: t, items: usable.filter((a) => a.type === t) })).filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data, org?.arAccountId, org?.apAccountId]);
  const taxMap = useMemo(() => new Map<string, TaxRateInfo>((taxRates.data ?? []).map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate, accountId: t.purchaseAccountId, kind: t.kind }])), [taxRates.data]);
  const vendor = vendors.data?.find((x) => x.id === contact);
  const wOptions = wSettings.data?.configured ? (wSections.data ?? []).filter((x) => x.kind === 'TDS') : [];

  // The schedule: the first bills and their vendor references.
  const sched = useMemo(() => {
    try {
      const s = { start: startDate, end: endDate || null, frequency, monthEnd, nextNo: ex?.nextRunNo ?? 1 };
      return { ok: true as const, count: runCount(s), next: upcomingRuns(s, 3) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [startDate, endDate, frequency, monthEnd, ex?.nextRunNo]);
  const firstDate = sched.ok && sched.next[0] ? sched.next[0].date : startDate;
  const refIssue = recurringReferenceIssue(reference, frequency);

  // India GST as on the first bill's date.
  const reg = gstReg.data?.registered ? gstReg.data : null;
  const gstMode = !!reg && !!firstDate && firstDate >= reg.effectiveFrom;
  const supplierState = vendor?.stateCode ?? null;
  const pos = placeOfSupply || reg?.stateCode || '';
  const nature = gstMode && supplierState && pos ? supplyNature(supplierState, pos) : null;
  const gstCategories = useMemo(() => new Map((taxRates.data ?? []).filter((t) => t.kind === 'GST').map((t) => [t.id, t.gstCategory as GstCategory])), [taxRates.data]);
  const splitter = useMemo(() => (nature ? gstSplitter({ nature, stateCode: pos, accounts: { cgst: 'cgst', sgst: 'sgst', igst: 'igst' }, categories: gstCategories }) : undefined), [nature, pos, gstCategories]);

  const filled = lines.filter((x) => x.accountId || x.unitPrice || x.description);
  const payloadLines = filled.map((x) => ({ accountId: x.accountId, description: x.description || null, quantity: x.quantity || '0', unitPrice: x.unitPrice || '0', taxRateId: x.taxRateId || null, hsnCode: x.hsnCode.trim() || null, departmentId: x.departmentId || null, projectId: x.projectId || null }));
  const calc = useMemo(() => {
    const issues: string[] = [];
    if (!contact) issues.push('Choose the vendor');
    if (!payloadLines.length) issues.push('Add at least one line');
    payloadLines.forEach((x, i) => !x.accountId && issues.push(`Line ${i + 1}: choose an account`));
    if (gstMode) {
      if (contact && !supplierState) issues.push(`Add ${vendor?.name ?? 'the vendor'}'s GSTIN or state before setting up a GST bill`);
      payloadLines.forEach((x, i) => {
        if (!x.taxRateId || !gstCategories.has(x.taxRateId)) issues.push(`Line ${i + 1}: choose a GST rate`);
        else if (gstCategories.get(x.taxRateId) !== 'NON_GST') {
          const h = hsnIssue(x.hsnCode);
          if (h) issues.push(`Line ${i + 1}: ${h}`);
        }
      });
    }
    try {
      let d = computeDocument(payloadLines.map((x) => ({ ...x, description: x.description ?? undefined })), c, taxMap, splitter);
      if (gstMode && reverseCharge) d = applyReverseCharge(d, RCM_ACCOUNTS);
      return { ok: issues.length === 0, issues, lines: d.lines, subtotal: d.subtotal.toFixed(2), tax: d.taxTotal.toFixed(2), total: d.total.toFixed(2), heads: gstHeads(d.lines.flatMap((x) => x.taxComponents)) };
    } catch (e) {
      return { ok: false, issues: [...issues, ...(e instanceof DocumentValidationError ? e.issues : [(e as Error).message])], lines: [], subtotal: null, tax: null, total: null, heads: null };
    }
  }, [payloadLines, c, taxMap, splitter, contact, gstMode, supplierState, vendor, gstCategories, reverseCharge]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        contactId: contact,
        reference: reference || null,
        memo: memo || null,
        placeOfSupply: gstMode ? placeOfSupply || null : null,
        reverseCharge: gstMode ? reverseCharge : false,
        withholdingSectionId: section || null,
        dueDays: dueDays === '' ? null : Number(dueDays),
        frequency,
        startDate,
        endDate: endDate || null,
        monthEnd,
        postMode,
        lines: payloadLines,
      };
      const base = `/v1/orgs/${orgId}/purchases/recurring-bills`;
      return existing ? api<RecurringBillDetail>(`${base}/${existing.id}`, { method: 'PUT', body }) : api<RecurringBillDetail>(base, { method: 'POST', body });
    },
    onSuccess: async (b) => {
      await qc.invalidateQueries({ queryKey: ['recurring-bills', orgId] });
      await qc.invalidateQueries({ queryKey: ['recurring-bill', orgId] });
      router.push(`/orgs/${orgId}/purchases/recurring-bills/${b.id}`);
    },
  });
  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const serverIssues = save.error instanceof ApiError ? save.error.issues : [];
  const ok = !!name.trim() && calc.ok && sched.ok && !refIssue && (dueDays === '' || (/^\d+$/.test(dueDays) && Number(dueDays) <= 365));

  if (!org) return null;
  const taxes = (taxRates.data ?? []).filter((t) => (gstMode ? t.kind === 'GST' : t.kind !== 'GST'));
  const mayPost = can(org.role, 'journals.post');
  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-6">
      {fromBill ? <Alert tone="accent" title={`Filled from ${fromBill.number ?? 'a draft bill'}`}>The vendor, lines and tax come from that bill. Give the vendor reference a placeholder such as {'{month}'} so each bill&apos;s reference is different, and choose when the bills start.</Alert> : null}
      <Card>
        <CardHeader title="Recurring bill" description="The vendor and what each bill says. Placeholders in the reference, memo and line descriptions become each bill's own dates." />
        <div className="grid gap-4 p-5 sm:grid-cols-4">
          <label className={cn(label, 'sm:col-span-2')}>
            Name
            <Input value={name} maxLength={120} placeholder="e.g. Office rent, Koramangala" onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className={cn(label, 'sm:col-span-2')}>
            Vendor
            <Select value={contact} disabled={ran} onChange={(e) => setContact(e.target.value)}>
              <option value="">Choose a vendor…</option>
              {(vendors.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </label>
          <label className={cn(label, 'sm:col-span-2')}>
            Vendor&apos;s invoice number
            <Input value={reference} maxLength={100} placeholder="e.g. RENT-{period} (optional)" onChange={(e) => setReference(e.target.value)} />
            {refIssue ? <span className="normal-case tracking-normal text-warning">{refIssue}</span> : null}
          </label>
          <label className={label}>
            Memo
            <Input value={memo} maxLength={1000} placeholder="e.g. Rent for {month}" onChange={(e) => setMemo(e.target.value)} />
          </label>
          <label className={label}>
            Due after (days)
            <Input inputMode="numeric" value={dueDays} placeholder={vendor ? `${vendor.paymentTermsDays} (vendor's terms)` : "Vendor's terms"} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setDueDays(e.target.value)} />
          </label>
          <div className="text-xs text-fg-muted sm:col-span-4">
            <p>
              Placeholders:{' '}
              {TEMPLATE_PLACEHOLDERS.map((p, i) => (
                <span key={p.key}>
                  {i ? ', ' : ''}
                  <code className="rounded bg-surface-sunken px-1 text-fg">{p.key}</code> {p.meaning.toLowerCase()}
                </span>
              ))}
              .
            </p>
            {(reference || memo) && sched.ok && sched.next[0] ? (
              <p className="mt-1" aria-live="polite">
                The bill of {fmtDate(firstDate)} reads: {reference ? <>invoice <span className="text-fg">{fillPlaceholders(reference, firstDate, fy)}</span></> : null}
                {reference && memo ? ' · ' : ''}
                {memo ? <span className="text-fg">{fillPlaceholders(memo, firstDate, fy)}</span> : null}
              </p>
            ) : null}
          </div>
          {gstMode ? (
            <div className="grid gap-4 rounded-lg border border-line bg-surface-raised p-4 sm:col-span-4 sm:grid-cols-4" aria-label="GST">
              <label className={cn(label, 'sm:col-span-2')}>
                Place of supply
                <Select value={pos} onChange={(e) => setPlaceOfSupply(e.target.value === reg?.stateCode ? '' : e.target.value)}>
                  {(states.data ?? []).filter((x) => x.code !== '96').map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
                </Select>
                <span className="normal-case tracking-normal text-fg-faint">Defaults to your state ({reg ? placeOfSupplyName(reg.stateCode) : ''}).</span>
              </label>
              <div className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">GST treatment</span>
                {nature ? <p className="font-medium">{nature === 'INTRA' ? 'Intra-state: CGST + SGST' : 'Inter-state: IGST'}{vendor?.gstin ? <span className="block text-xs font-normal text-fg-muted">Supplier GSTIN {vendor.gstin}</span> : null}</p> : <p className="text-fg-faint">Choose the vendor.</p>}
              </div>
              <label className="flex items-start gap-2 text-sm sm:col-span-4">
                <input type="checkbox" className="mt-0.5 accent-[var(--t2t-accent)]" checked={reverseCharge} onChange={(e) => setReverseCharge(e.target.checked)} />
                <span><span className="font-medium">Reverse charge</span><span className="block text-xs text-fg-muted">You pay the GST on these bills instead of the vendor.</span></span>
              </label>
            </div>
          ) : null}
          {wOptions.length ? (
            <label className={cn(label, 'sm:col-span-2')}>
              TDS section
              <Select value={section} onChange={(e) => setSection(e.target.value)}>
                <option value="">No TDS</option>
                {wOptions.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name} ({x.rate}%)</option>)}
              </Select>
              <span className="normal-case tracking-normal text-fg-faint">Worked out on each bill, with the thresholds as they stand that day.</span>
            </label>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Bill lines" description={`Amounts in ${c}. Tax is worked out on each bill with the rates in force on its date; the totals here are for the first bill.`} />
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
                    <label className="sr-only" htmlFor={`rb-acc-${x.key}`}>Account for line {idx + 1}</label>
                    <Select id={`rb-acc-${x.key}`} value={x.accountId} onChange={(e) => update(x.key, { accountId: e.target.value })}>
                      <option value="">Select account…</option>
                      {choices.map((g) => (
                        <optgroup key={g.type} label={g.type.charAt(0) + g.type.slice(1).toLowerCase()}>
                          {g.items.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                    <LineDimensions values={dims.data?.values} line={idx + 1} departmentId={x.departmentId} projectId={x.projectId} onChange={(p) => update(x.key, p)} />
                  </Td>
                  <Td><Input aria-label={`Description for line ${idx + 1}`} value={x.description} maxLength={500} placeholder="e.g. Rent {month}" onChange={(e) => update(x.key, { description: e.target.value })} /></Td>
                  <Td numeric><Input aria-label={`Quantity for line ${idx + 1}`} className="num text-right" inputMode="decimal" value={x.quantity} onChange={(e) => QTY.test(e.target.value) && update(x.key, { quantity: e.target.value })} /></Td>
                  <Td numeric><Input aria-label={`Unit price for line ${idx + 1}`} className="num text-right" inputMode="decimal" placeholder="0.00" value={x.unitPrice} onChange={(e) => QTY.test(e.target.value) && update(x.key, { unitPrice: e.target.value })} /></Td>
                  {gstMode ? (
                    <Td><Input aria-label={`HSN or SAC for line ${idx + 1}`} className="num" inputMode="numeric" maxLength={8} placeholder="997212" value={x.hsnCode} onChange={(e) => /^\d{0,8}$/.test(e.target.value) && update(x.key, { hsnCode: e.target.value })} /></Td>
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
                        {computed.taxComponents.map((tc) => <p key={tc.code} className="text-xs text-fg-muted">+ {tc.code} {tc.rate.toFixed()}% {money(tc.amount.toFixed(2), c)}</p>)}
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
                <p>{gstMode ? (reverseCharge ? 'GST (reverse charge, not owed to the vendor)' : 'GST') : 'Tax'}</p>
                <p className="font-semibold text-fg">Each bill</p>
              </Td>
              <Td numeric className="text-sm">
                <p className="num">{money(calc.subtotal, c)}</p>
                <p className="num">{money(calc.heads && gstMode ? calc.heads.cgst.plus(calc.heads.sgst).plus(calc.heads.igst).toFixed(2) : calc.tax, c)}</p>
                <p className="num font-semibold">{money(calc.total, c)}</p>
              </Td>
              <Td />
            </tr>
          </tfoot>
        </Table>
        {calc.issues.length && filled.length ? (
          <ul className="list-inside list-disc border-t border-line px-5 py-3 text-sm text-warning" aria-live="polite">
            {calc.issues.slice(0, 4).map((i) => <li key={i}>{i}</li>)}
          </ul>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Bill schedule" description="When the bills are made. Each bill is dated its run date; a run that falls due is made at the next hourly check." />
        <div className="grid gap-4 p-5 sm:grid-cols-4">
          <label className={label}>
            Every
            <Select value={frequency} disabled={ran} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
              {RECURRING_FREQUENCIES.map((f) => <option key={f} value={f}>{RECURRING_FREQUENCY_LABEL[f]}</option>)}
            </Select>
          </label>
          <label className={label}>
            First bill date
            <Input type="date" value={startDate} disabled={ran} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className={label}>
            Last date (optional)
            <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-muted">
            <input type="checkbox" checked={monthEnd} disabled={ran} onChange={(e) => setMonthEnd(e.target.checked)} className="accent-[var(--t2t-accent)]" />
            On the month&apos;s last day
          </label>
          <fieldset className="sm:col-span-4">
            <legend className="text-xs font-medium uppercase tracking-wide text-fg-muted">Each bill</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="rbPostMode" checked={postMode === 'DRAFT'} onChange={() => setPostMode('DRAFT')} className="accent-[var(--t2t-accent)]" />
                Is saved as a draft for someone to check and post
              </label>
              <label className={cn('flex items-center gap-2', !mayPost && 'opacity-50')}>
                <input type="radio" name="rbPostMode" checked={postMode === 'POST'} disabled={!mayPost} onChange={() => setPostMode('POST')} className="accent-[var(--t2t-accent)]" />
                Is posted straight away{!mayPost ? ' (needs permission to post)' : ''}
              </label>
            </div>
          </fieldset>
          <div className="text-sm sm:col-span-4" aria-live="polite">
            {ran ? <p className="mb-1 text-xs text-fg-muted">This recurring bill has made bills, so its vendor, first date, frequency and run day stay as they are.</p> : null}
            {!sched.ok ? (
              <p className="text-warning">{sched.error}</p>
            ) : (
              <p className="text-fg-muted">
                {sched.count ? `${sched.count} bill${sched.count === 1 ? '' : 's'} in all. ` : 'Runs until you end it. '}
                Next: {sched.next.map((r) => fmtDate(r.date)).join(', ') || 'none left before the last date'}.
                {sched.next.some((r) => r.date <= today()) ? <span className="text-warning"> Bills dated today or earlier are made at the next hourly check, or straight away with Make due bills now.</span> : null}
              </p>
            )}
          </div>
        </div>
      </Card>

      {save.error ? (
        <Alert title="The recurring bill was not saved">
          {save.error.message}
          {serverIssues.length ? <ul className="mt-1 list-inside list-disc">{serverIssues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </Alert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="button" loading={save.isPending} disabled={!ok || save.isPending} onClick={() => save.mutate()}>
          {existing ? 'Save changes' : 'Save recurring bill'}
        </Button>
      </div>
    </form>
  );
}
