'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseUsageCsv, USAGE_PRICING, USAGE_PRICING_LABEL, type UsagePricing } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useAccounts, useTaxRates } from '@/lib/org';

export interface Meter {
  id: string;
  code: string;
  name: string;
  unit: string;
  account: { id: string; code: string; name: string } | null;
  taxRateId: string | null;
  hsnCode: string | null;
  pricing: UsagePricing;
  tiers: { upTo: string | null; unitPrice: string }[];
  includedQuantity: string;
  minimumCharge: string | null;
  summary: string;
  active: boolean;
  usedThisPeriod: string;
  readingsThisPeriod: number;
  estimate: string | null;
  unbilledReadings: number;
}
interface Meters {
  contract: { id: string; reference: string; status: string; timing: 'ADVANCE' | 'ARREARS'; currency: string };
  currentPeriod: { periodNo: number; start: string; end: string; billDate: string } | null;
  meters: Meter[];
  can: { manage: boolean };
}
interface UsageRow {
  id: string;
  meter: { code: string; name: string; unit: string };
  date: string;
  quantity: string;
  reference: string | null;
  note: string | null;
  source: string;
  periodNo: number | null;
  documentId: string | null;
  recordedBy: string | null;
  voided: { at: string; by: string | null; reason: string | null } | null;
}

const qty = (s: string) => Number(s).toLocaleString('en-IN', { maximumFractionDigits: 6 });

/** Usage-based charges on a contract (AR-012): meters, the usage recorded against them and what the current period comes to so far. */
export function UsageCard({ orgId, contractId, status, onChange }: { orgId: string; contractId: string; status: string; onChange: () => Promise<void> }) {
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/sales/contracts/${contractId}`;
  // Keyed by the contract's status, so activating, pausing or ending it refreshes the card.
  const mKey = ['contract-meters', orgId, contractId, status];
  const [view, setView] = useState<'unbilled' | 'all'>('unbilled');
  const uKey = ['contract-usage', orgId, contractId, view];
  const meters = useQuery({ queryKey: mKey, queryFn: () => api<Meters>(`${base}/meters`) });
  const usage = useQuery({ queryKey: uKey, queryFn: () => api<UsageRow[]>(`${base}/usage${view === 'all' ? '?all=true' : ''}`) });
  const [editing, setEditing] = useState<Meter | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [voiding, setVoiding] = useState<UsageRow | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['contract-meters', orgId, contractId] });
    await qc.invalidateQueries({ queryKey: ['contract-usage', orgId, contractId] });
    await onChange();
  };
  const m = meters.data;
  if (!m) return <ErrorAlert title="Could not load the usage charges" error={meters.error} />;
  const recording = m.contract.status === 'ACTIVE' || m.contract.status === 'PAUSED';
  const open = m.contract.status !== 'ENDED' && m.contract.status !== 'CANCELLED';
  const cur = m.contract.currency;
  const total = m.meters.reduce((s, x) => s + Number(x.estimate ?? 0), 0);
  return (
    <Card role="region" aria-label="Usage charges">
      <CardHeader
        title="Usage charges"
        description="Charges worked out each period from the usage you record: API calls, storage, hours or anything you count. Usage is billed in arrears on the period's invoice, next to the fixed lines."
        actions={m.can.manage && open && m.contract.timing === 'ARREARS' ? <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>Add usage charge</Button> : null}
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {m.contract.timing !== 'ARREARS' ? <p className="text-sm text-fg-muted">This contract bills in advance. Usage charges need a contract billed in arrears, after each period ends; change it while it is a draft.</p> : null}
        {m.meters.length ? (
          <Table aria-label="Meters">
            <thead><Tr><Th>Charge</Th><Th>Code</Th><Th>Price</Th><Th numeric>Used {m.currentPeriod ? `since ${date(m.currentPeriod.start)}` : ''}</Th><Th numeric>So far this period</Th><Th /></Tr></thead>
            <tbody>
              {m.meters.map((x) => (
                <Tr key={x.id}>
                  <Td>{x.name}{x.active ? null : <> <Badge tone="neutral">Off</Badge></>}<span className="block text-xs text-fg-muted">{x.account ? `${x.account.code} ${x.account.name}` : ''}</span></Td>
                  <Td className="font-mono text-xs">{x.code}</Td>
                  <Td className="text-sm">{x.summary}</Td>
                  <Td numeric>{qty(x.usedThisPeriod)} {x.unit}<span className="block text-xs text-fg-muted">{x.readingsThisPeriod} {x.readingsThisPeriod === 1 ? 'reading' : 'readings'}</span></Td>
                  <Td numeric>{x.estimate !== null ? <Money value={x.estimate} currency={cur} /> : '—'}</Td>
                  <Td>{m.can.manage && open ? <Button size="sm" variant="ghost" onClick={() => setEditing(x)}>Change…</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : m.contract.timing === 'ARREARS' ? <p className="text-sm text-fg-muted">No usage charges yet.</p> : null}
        {m.meters.length && m.currentPeriod ? (
          <p className="text-sm text-fg-muted">
            Period {m.currentPeriod.periodNo}, {date(m.currentPeriod.start)} to {date(m.currentPeriod.end)}: usage so far comes to <span className="font-medium text-fg"><Money value={total.toFixed(2)} currency={cur} /></span> before tax, invoiced on {date(m.currentPeriod.billDate)}. More usage before then is added.
          </p>
        ) : null}
        {m.can.manage && recording && m.meters.some((x) => x.active) ? <RecordForm base={base} meters={m.meters.filter((x) => x.active)} onDone={refresh} onImport={() => setImporting(true)} /> : null}
        {m.meters.length ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recorded usage</h3>
              <Select aria-label="Which usage" value={view} onChange={(e) => setView(e.target.value as 'unbilled' | 'all')}><option value="unbilled">Not billed yet</option><option value="all">All, including billed and voided</option></Select>
            </div>
            {usage.data && usage.data.length ? (
              <Table aria-label="Recorded usage">
                <thead><Tr><Th>Date</Th><Th>Charge</Th><Th numeric>Quantity</Th><Th>Reference</Th><Th>Recorded</Th><Th>Status</Th><Th /></Tr></thead>
                <tbody>
                  {usage.data.map((u) => (
                    <Tr key={u.id}>
                      <Td>{date(u.date)}</Td>
                      <Td>{u.meter.name}</Td>
                      <Td numeric>{qty(u.quantity)} {u.meter.unit}</Td>
                      <Td className="text-sm">{u.reference ?? '—'}{u.note ? <span className="block text-xs text-fg-muted">{u.note}</span> : null}</Td>
                      <Td className="text-sm">{u.recordedBy ?? '—'}<span className="block text-xs text-fg-muted">{u.source === 'IMPORT' ? 'Imported' : u.source === 'API' ? 'Through the API' : 'By hand'}</span></Td>
                      <Td>{u.voided ? <Badge tone="negative">Voided</Badge> : u.periodNo ? <Badge tone="positive">Billed, period {u.periodNo}</Badge> : <Badge tone="neutral">To bill</Badge>}{u.voided?.reason ? <span className="block text-xs text-fg-muted">{u.voided.reason}</span> : null}</Td>
                      <Td>{m.can.manage && !u.voided && !u.periodNo ? <Button size="sm" variant="ghost" onClick={() => setVoiding(u)}>Void…</Button> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : usage.data ? <p className="text-sm text-fg-muted">{view === 'unbilled' ? 'No usage waiting to be billed.' : 'No usage recorded yet.'}</p> : null}
          </div>
        ) : null}
      </div>
      {editing ? <MeterDialog base={base} meter={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={refresh} /> : null}
      {importing ? <ImportDialog base={base} onClose={() => setImporting(false)} onDone={refresh} /> : null}
      {voiding ? <VoidDialog base={base} row={voiding} onClose={() => setVoiding(null)} onDone={refresh} /> : null}
    </Card>
  );
}

function RecordForm({ base, meters, onDone, onImport }: { base: string; meters: Meter[]; onDone: () => Promise<void>; onImport: () => void }) {
  const [f, setF] = useState({ meterId: meters[0]!.id, date: today(), quantity: '', reference: '', note: '' });
  const [dup, setDup] = useState(false);
  const m = useMutation({
    mutationFn: () => api<{ duplicate: boolean }>(`${base}/usage`, { method: 'POST', body: { meterId: f.meterId, date: f.date, quantity: f.quantity.replace(/,/g, ''), reference: f.reference || null, note: f.note || null } }),
    onSuccess: async (r) => {
      setDup(r.duplicate);
      if (!r.duplicate) setF({ ...f, quantity: '', reference: '', note: '' });
      await onDone();
    },
  });
  const unit = meters.find((x) => x.id === f.meterId)?.unit ?? '';
  return (
    <form role="form" aria-label="Record usage" className="rounded-lg border border-border p-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Charge">{(p) => <Select {...p} value={f.meterId} onChange={(e) => setF({ ...f, meterId: e.target.value })}>{meters.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="Date">{(p) => <Input {...p} type="date" max={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label={`Quantity (${unit})`} hint="Negative to correct an earlier period.">{(p) => <Input {...p} inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />}</Field>
        <Field label="Reference (optional)" hint="Sent twice, recorded once.">{(p) => <Input {...p} maxLength={100} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
        <Field label="Note (optional)">{(p) => <Input {...p} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={m.isPending} disabled={!f.quantity.trim()}>Record usage</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onImport}>Import a CSV…</Button>
        {dup ? <span role="status" className="text-sm text-fg-muted">Already recorded with that reference; not added again.</span> : null}
        <ErrorAlert title="Usage not recorded" error={m.error} />
      </div>
    </form>
  );
}

function MeterDialog({ base, meter, onClose, onDone }: { base: string; meter: Meter | null; onClose: () => void; onDone: () => Promise<void> }) {
  const accounts = useAccounts();
  const rates = useTaxRates();
  const income = (accounts.data ?? []).filter((a) => a.type === 'REVENUE' && a.isPostable && a.isActive);
  const [f, setF] = useState({
    code: meter?.code ?? '',
    name: meter?.name ?? '',
    unit: meter?.unit ?? '',
    accountId: meter?.account?.id ?? '',
    taxRateId: meter?.taxRateId ?? '',
    hsnCode: meter?.hsnCode ?? '',
    pricing: meter?.pricing ?? ('PER_UNIT' as UsagePricing),
    includedQuantity: meter && Number(meter.includedQuantity) ? meter.includedQuantity : '',
    minimumCharge: meter?.minimumCharge ?? '',
    active: meter?.active ?? true,
  });
  const [tiers, setTiers] = useState(meter?.tiers.map((t) => ({ upTo: t.upTo ?? '', unitPrice: t.unitPrice })) ?? [{ upTo: '', unitPrice: '' }]);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: f.code.trim(),
        name: f.name,
        unit: f.unit,
        accountId: f.accountId || income[0]?.id,
        taxRateId: f.taxRateId || null,
        hsnCode: f.hsnCode || null,
        pricing: f.pricing,
        tiers: (f.pricing === 'PER_UNIT' ? tiers.slice(0, 1) : tiers).map((t, i, all) => ({ upTo: i === all.length - 1 ? null : t.upTo.replace(/,/g, ''), unitPrice: t.unitPrice.replace(/,/g, '') })),
        includedQuantity: f.includedQuantity.replace(/,/g, '') || '0',
        minimumCharge: f.minimumCharge.replace(/,/g, '') || null,
        ...(meter ? { active: f.active } : {}),
      };
      return meter ? api(`${base}/meters/${meter.id}`, { method: 'PUT', body }) : api(`${base}/meters`, { method: 'POST', body });
    },
    onSuccess: async () => { await onDone(); onClose(); },
  });
  const remove = useMutation({ mutationFn: () => api(`${base}/meters/${meter!.id}`, { method: 'DELETE' }), onSuccess: async () => { await onDone(); onClose(); } });
  const tiered = f.pricing !== 'PER_UNIT';
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={meter ? `Change ${meter.name}` : 'Add a usage charge'} description="New prices apply to periods billed from now on. Periods already billed keep their invoices.">
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name on the invoice">{(p) => <Input {...p} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="API calls" />}</Field>
          <Field label="Meter code" hint={meter ? 'Fixed once created.' : 'Used in imports, e.g. api_calls.'}>{(p) => <Input {...p} maxLength={40} disabled={!!meter} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
          <Field label="Unit" hint="Singular: call, GB, hour.">{(p) => <Input {...p} maxLength={30} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Income account">{(p) => <Select {...p} value={f.accountId || income[0]?.id || ''} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{income.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>}</Field>
          <Field label="Tax rate">{(p) => <Select {...p} value={f.taxRateId} onChange={(e) => setF({ ...f, taxRateId: e.target.value })}><option value="">No tax</option>{(rates.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
          <Field label="HSN/SAC (optional)">{(p) => <Input {...p} maxLength={8} value={f.hsnCode} onChange={(e) => setF({ ...f, hsnCode: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Pricing">{(p) => <Select {...p} value={f.pricing} onChange={(e) => setF({ ...f, pricing: e.target.value as UsagePricing })}>{USAGE_PRICING.map((x) => <option key={x} value={x}>{USAGE_PRICING_LABEL[x]}</option>)}</Select>}</Field>
          <Field label="Included each period" hint="Free units before charging.">{(p) => <Input {...p} inputMode="decimal" value={f.includedQuantity} onChange={(e) => setF({ ...f, includedQuantity: e.target.value })} placeholder="0" />}</Field>
          <Field label="Minimum charge a period (optional)">{(p) => <Input {...p} inputMode="decimal" value={f.minimumCharge} onChange={(e) => setF({ ...f, minimumCharge: e.target.value })} />}</Field>
        </div>
        <div>
          <p className="mb-2 text-sm text-fg-muted">{f.pricing === 'PER_UNIT' ? 'One price for every unit after the included ones.' : f.pricing === 'GRADUATED' ? 'Each tier prices the units that fall within it.' : 'Every unit is priced at the tier the whole quantity reaches.'}</p>
          {(tiered ? tiers : tiers.slice(0, 1)).map((t, i, all) => (
            <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              {tiered ? (
                i === all.length - 1 ? <p className="pb-2 text-sm">Tier {i + 1}: everything above {all[i - 1]?.upTo || '0'}</p> : <Field label={`Tier ${i + 1}: up to`}>{(p) => <Input {...p} inputMode="decimal" value={t.upTo} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))} />}</Field>
              ) : <span />}
              <Field label={tiered ? `Tier ${i + 1}: price per unit` : 'Price per unit'}>{(p) => <Input {...p} inputMode="decimal" value={t.unitPrice} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />}</Field>
              {tiered && all.length > 1 ? <Button variant="ghost" size="sm" aria-label={`Remove tier ${i + 1}`} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove</Button> : <span />}
            </div>
          ))}
          {tiered ? <Button variant="ghost" size="sm" onClick={() => setTiers([...tiers.slice(0, -1), { upTo: '', unitPrice: '' }, tiers[tiers.length - 1]!])}>Add a tier</Button> : null}
        </div>
        {meter ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Bill this charge (untick to stop billing it)</label> : null}
        <ErrorAlert title="Usage charge not saved" error={save.error ?? remove.error} />
        <div className="flex justify-between gap-2">
          {meter && !meter.unbilledReadings && meter.readingsThisPeriod === 0 ? <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button loading={save.isPending} disabled={!f.name.trim() || !f.code.trim() || !f.unit.trim()} onClick={() => save.mutate()}>Save usage charge</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [text, setText] = useState('');
  const parsed = text.trim() ? parseUsageCsv(text) : null;
  const m = useMutation({
    mutationFn: () => api<{ recorded: number; duplicates: number }>(`${base}/usage/import`, { method: 'POST', body: { rows: parsed!.rows } }),
    onSuccess: onDone,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Import usage" description="Paste or open a CSV with the columns meter, date (YYYY-MM-DD), quantity and optionally reference. Nothing is recorded if any row is wrong; rows whose reference was already recorded are skipped.">
      <div className="flex flex-col gap-4">
        <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setText(await file.text()); }} />
        <Field label="CSV">{(p) => <Textarea {...p} rows={8} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'meter,date,quantity,reference\napi_calls,2026-11-03,1200,batch-0311'} />}</Field>
        {parsed ? (
          parsed.errors.length ? (
            <Alert tone="warning" title="Fix these rows first"><ul className="list-disc pl-5">{parsed.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul></Alert>
          ) : <p className="text-sm text-fg-muted">{parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'} ready.</p>
        ) : null}
        {m.data ? <p role="status" className="text-sm">Recorded {m.data.recorded}; {m.data.duplicates} already recorded and skipped.</p> : null}
        <ErrorAlert title="Nothing was imported" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{m.data ? 'Done' : 'Cancel'}</Button>
          {!m.data ? <Button loading={m.isPending} disabled={!parsed || !!parsed.errors.length || !parsed.rows.length} onClick={() => m.mutate()}>Import {parsed?.rows.length ?? 0} rows</Button> : null}
        </div>
      </div>
    </Dialog>
  );
}

function VoidDialog({ base, row, onClose, onDone }: { base: string; row: UsageRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`${base}/usage/${row.id}/void`, { method: 'POST', body: { reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Void this usage" description={`${qty(row.quantity)} ${row.meter.unit} of ${row.meter.name} on ${date(row.date)}. It stays in the record, marked voided, and is not billed.`}>
      <div className="flex flex-col gap-4">
        <Field label="Why">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Counted twice by the exporter" />}</Field>
        <ErrorAlert title="Not voided" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>Void usage</Button>
        </div>
      </div>
    </Dialog>
  );
}
