'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { expectedValidUntil, transportIssues, vehicleNoIssue } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { downloadJson, istTime } from '@/components/e-invoice';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useGstStates } from '@/lib/org';
import type { EWayBillDocument, EWayBillRecord, EWayBillState, TransportMode } from '@/lib/types';

export const EWB_STATE: Record<EWayBillState, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' }> = {
  NEEDED: { label: 'E-way bill needed', tone: 'warning' },
  OPTIONAL: { label: 'Optional', tone: 'neutral' },
  NEEDS_DATA: { label: 'Needs details', tone: 'warning' },
  TOO_OLD: { label: 'Too old for portal', tone: 'negative' },
  GENERATED: { label: 'E-way bill recorded', tone: 'positive' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'neutral' },
  UNSUPPORTED: { label: 'Not supported', tone: 'warning' },
};
const MODES: { value: TransportMode | ''; label: string }[] = [
  { value: 'ROAD', label: 'Road' },
  { value: 'RAIL', label: 'Rail' },
  { value: 'AIR', label: 'Air' },
  { value: 'SHIP', label: 'Ship' },
  { value: '', label: 'Part A only (vehicle later)' },
];
const MODE_LABEL: Record<TransportMode, string> = { ROAD: 'Road', RAIL: 'Rail', AIR: 'Air', SHIP: 'Ship' };

/** An India time typed in a datetime-local box ("2026-11-01T10:30") as an ISO timestamp, and back. */
export const fromIst = (local: string) => (local ? new Date(`${local}:00+05:30`).toISOString() : '');
export const toIst = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16);
const nowIst = () => toIst(new Date().toISOString());

interface TransportDraft {
  mode: TransportMode | '';
  distanceKm: string;
  vehicleNo: string;
  odc: boolean;
  transporterId: string;
  transporterName: string;
  transDocNo: string;
  transDocDate: string;
}
const blankTransport: TransportDraft = { mode: 'ROAD', distanceKm: '', vehicleNo: '', odc: false, transporterId: '', transporterName: '', transDocNo: '', transDocDate: '' };
const transportBody = (t: TransportDraft) => ({
  mode: t.mode || null,
  distanceKm: Number(t.distanceKm),
  vehicleNo: t.vehicleNo.trim() || null,
  vehicleType: t.odc ? 'O' : 'R',
  transporterId: t.transporterId.trim() || null,
  transporterName: t.transporterName.trim() || null,
  transDocNo: t.transDocNo.trim() || null,
  transDocDate: t.transDocDate || null,
});

function issuesOf(e: unknown) {
  return e instanceof ApiError ? [e.message, ...e.issues] : ['Try again.'];
}
function ErrorBox({ title, error }: { title: string; error: unknown }) {
  if (!error) return null;
  const [first, ...rest] = issuesOf(error);
  return <Alert title={title}>{first}{rest.length ? <ul className="mt-1 list-inside list-disc">{rest.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert>;
}

/** The e-way bill card on an invoice: whether one is needed, preparing and recording it, Part B updates and cancellation. */
export function EWayBillPanel({ orgId, documentId, issueDate, canManage, onChange }: { orgId: string; documentId: string; issueDate: string; canManage: boolean; onChange: () => Promise<void> | void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ewaybill', orgId, documentId], queryFn: () => api<EWayBillDocument>(`/v1/orgs/${orgId}/e-way-bills/documents/${documentId}`) });
  const [prepare, setPrepare] = useState(false);
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['ewaybill', orgId] });
    await onChange();
  };
  const d = q.data;
  if (!d || !d.configured) return null;
  if (!d.history.length && (d.state === 'NOT_APPLICABLE' || (d.state === 'OPTIONAL' && !canManage))) return null;
  const s = EWB_STATE[d.state];
  const live = d.state === 'GENERATED' ? d.eWayBill : null;
  const canCancel = live && Date.parse(live.cancellableUntil) > Date.now();
  const canUpdate = live && !live.expired;

  return (
    <Card className="mt-6" aria-label="E-way bill">
      <CardHeader
        title={<span className="flex items-center gap-2">E-way bill <Badge tone={s.tone}>{s.label}</Badge></span>}
        description={d.reason}
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              {d.state === 'NEEDED' || d.state === 'OPTIONAL' ? <Button size="sm" variant={d.state === 'NEEDED' ? 'primary' : 'secondary'} onClick={() => setPrepare(true)}>Prepare e-way bill…</Button> : null}
              {canUpdate ? <Button size="sm" variant="secondary" onClick={() => setVehicleOpen(true)}>{live.partB ? 'Change vehicle…' : 'Add vehicle (Part B)…'}</Button> : null}
              {canCancel ? <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>Record cancellation…</Button> : null}
            </div>
          ) : null
        }
      />
      {d.state === 'NEEDS_DATA' ? (
        <ul className="list-inside list-disc px-5 py-4 text-sm text-warning">
          {d.issues.map((i) => <li key={`${i.field}${i.message}`}>{i.message}</li>)}
          <li className="list-none pt-2 text-fg-muted">
            Fix these on the <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${d.contact.id}`}>customer</Link> or in the <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/e-way-bills`}>e-way bill settings</Link>.
          </li>
        </ul>
      ) : null}
      {live ? <BillDetails b={live} /> : null}
      {d.history.filter((h) => h.status === 'CANCELLED').length ? (
        <div className="border-t border-line px-5 py-3 text-sm">
          <p className="font-medium">Cancelled e-way bills</p>
          <ul className="mt-1 space-y-1 text-fg-muted">
            {d.history.filter((h) => h.status === 'CANCELLED').map((h) => (
              <li key={h.id}><span className="num">{h.number}</span> · generated {istTime(h.generatedAt)} · cancelled {istTime(h.cancelledAt!)} ({h.cancelReason}: {h.cancelRemark})</li>
            ))}
          </ul>
        </div>
      ) : null}
      {prepare ? <PrepareDialog orgId={orgId} documentId={documentId} issueDate={issueDate} onClose={() => setPrepare(false)} onDone={refresh} /> : null}
      {vehicleOpen && live ? <VehicleDialog orgId={orgId} documentId={documentId} b={live} onClose={() => setVehicleOpen(false)} onDone={refresh} /> : null}
      {cancelOpen && live ? <CancelDialog orgId={orgId} documentId={documentId} b={live} onClose={() => setCancelOpen(false)} onDone={refresh} /> : null}
    </Card>
  );
}

function BillDetails({ b }: { b: EWayBillRecord }) {
  return (
    <div className="px-5 py-4">
      <dl className="grid gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
        <dt className="text-fg-muted">E-way bill number</dt>
        <dd className="num font-medium">{b.number}</dd>
        <dt className="text-fg-muted">Generated</dt>
        <dd>{istTime(b.generatedAt)}</dd>
        <dt className="text-fg-muted">Valid until</dt>
        <dd>
          {b.validUntil ? (
            <>
              {istTime(b.validUntil)} {b.expired ? <Badge tone="negative">Expired</Badge> : null}
              {b.expectedValidUntil && b.expectedValidUntil !== b.validUntil ? <span className="text-fg-muted"> · Rule 138(10) gives {istTime(b.expectedValidUntil)} for {b.distanceKm} km; the portal’s time counts</span> : null}
            </>
          ) : (
            <span className="text-warning">Not started: validity begins when the vehicle (Part B) is entered</span>
          )}
        </dd>
        <dt className="text-fg-muted">Distance</dt>
        <dd>{b.distanceKm} km{b.vehicleType === 'O' ? ' · over-dimensional cargo' : ''}</dd>
        <dt className="text-fg-muted">Vehicle (Part B)</dt>
        <dd>{b.partB ? <>{MODE_LABEL[b.partB.mode]}{b.partB.vehicleNo ? <> · <span className="num">{b.partB.vehicleNo}</span></> : null}{b.partB.transDocNo ? <> · document <span className="num">{b.partB.transDocNo}</span></> : null}</> : <span className="text-fg-muted">None yet</span>}</dd>
        {b.transporterId || b.transporterName ? (
          <>
            <dt className="text-fg-muted">Transporter</dt>
            <dd>{b.transporterName}{b.transporterId ? <> · <span className="num">{b.transporterId}</span></> : null}</dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Cancellable until</dt>
        <dd>{Date.parse(b.cancellableUntil) > Date.now() ? istTime(b.cancellableUntil) : <span className="text-fg-muted">Closed at {istTime(b.cancellableUntil)}</span>}</dd>
      </dl>
      {b.updates.length ? (
        <div className="mt-4 overflow-x-auto">
          <Table>
            <thead>
              <tr><Th>Part B update</Th><Th>Vehicle or document</Th><Th>From</Th><Th>Reason</Th></tr>
            </thead>
            <tbody>
              {b.updates.map((u) => (
                <tr key={u.id} className="border-t border-line">
                  <Td>{istTime(u.updatedAt)}</Td>
                  <Td>{MODE_LABEL[u.mode]} · <span className="num">{u.vehicleNo ?? u.transDocNo}</span></Td>
                  <Td>{u.fromPlace}</Td>
                  <Td>{u.reason}: {u.remark}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function TransportFields({ t, set, issueDate }: { t: TransportDraft; set: (t: TransportDraft) => void; issueDate: string }) {
  const km = Number(t.distanceKm);
  const vIssue = t.mode === 'ROAD' && t.vehicleNo.trim() ? vehicleNoIssue(t.vehicleNo) : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Mode of transport">
        {(p) => (
          <Select {...p} value={t.mode} onChange={(e) => set({ ...t, mode: e.target.value as TransportMode | '' })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Distance (km)" hint={km >= 1 ? `Valid for ${Math.max(1, Math.ceil(km / (t.odc ? 20 : 200)))} day(s) from Part B (Rule 138(10))` : 'As the portal works it out from the PIN codes; it allows 10% more.'}>
        {(p) => <Input {...p} inputMode="numeric" value={t.distanceKm} onChange={(e) => /^\d{0,4}$/.test(e.target.value) && set({ ...t, distanceKm: e.target.value })} />}
      </Field>
      {t.mode === 'ROAD' || t.mode === 'SHIP' ? (
        <Field label={t.mode === 'SHIP' ? 'Vessel number' : 'Vehicle number'} error={vIssue ?? undefined}>
          {(p) => <Input {...p} className="num uppercase" maxLength={20} value={t.vehicleNo} onChange={(e) => set({ ...t, vehicleNo: e.target.value.toUpperCase() })} />}
        </Field>
      ) : null}
      {t.mode === 'ROAD' ? (
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="accent-[var(--t2t-accent)]" checked={t.odc} onChange={(e) => set({ ...t, odc: e.target.checked })} /> Over-dimensional cargo (20 km a day)
        </label>
      ) : null}
      {t.mode && t.mode !== 'ROAD' ? (
        <>
          <Field label="Transport document number" hint="Railway receipt, airway bill or bill of lading.">{(p) => <Input {...p} maxLength={15} value={t.transDocNo} onChange={(e) => set({ ...t, transDocNo: e.target.value })} />}</Field>
          <Field label="Transport document date">{(p) => <Input {...p} type="date" min={issueDate} value={t.transDocDate} onChange={(e) => set({ ...t, transDocDate: e.target.value })} />}</Field>
        </>
      ) : null}
      <Field label="Transporter ID (optional)" hint="The transporter’s GSTIN or TRANSIN; needed for Part A only.">
        {(p) => <Input {...p} className="num uppercase" maxLength={15} value={t.transporterId} onChange={(e) => set({ ...t, transporterId: e.target.value.toUpperCase() })} />}
      </Field>
      <Field label="Transporter name (optional)">{(p) => <Input {...p} maxLength={100} value={t.transporterName} onChange={(e) => set({ ...t, transporterName: e.target.value })} />}</Field>
    </div>
  );
}

function PrepareDialog({ orgId, documentId, issueDate, onClose, onDone }: { orgId: string; documentId: string; issueDate: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [t, setT] = useState<TransportDraft>(blankTransport);
  const [number, setNumber] = useState('');
  const [generatedAt, setGeneratedAt] = useState(nowIst());
  const [validUntil, setValidUntil] = useState('');
  const body = transportBody(t);
  const local = Number(t.distanceKm) >= 1 ? transportIssues({ ...body, mode: body.mode, vehicleType: body.vehicleType as 'R' | 'O' }, { issueDate, samePin: false }) : [{ field: 'transport.distanceKm', message: 'Enter the distance' }];
  const expected = t.mode && generatedAt && Number(t.distanceKm) >= 1 ? toIst(expectedValidUntil(fromIst(generatedAt), Number(t.distanceKm), t.odc ? 'O' : 'R')) : '';
  const json = useMutation({
    mutationFn: () => api<{ version: string; billLists: { docNo: string }[] }>(`/v1/orgs/${orgId}/e-way-bills/documents/${documentId}/json`, { method: 'POST', body: { transport: body } }),
    onSuccess: (f) => downloadJson(`${f.billLists[0].docNo.replace(/[^A-Za-z0-9-]/g, '_')}-ewaybill.json`, f),
  });
  const save = useMutation({
    mutationFn: () => api<EWayBillRecord>(`/v1/orgs/${orgId}/e-way-bills/documents/${documentId}/e-way-bill`, { method: 'POST', body: { number, generatedAt: fromIst(generatedAt), validUntil: t.mode ? fromIst(validUntil || expected) : null, transport: body } }),
    onSuccess: async () => {
      onClose();
      await onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Prepare the e-way bill">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">Enter how the goods move, download the JSON and upload it on ewaybillgst.gov.in (bulk generation), or key it in there. Then record the e-way bill number the portal gives.</p>
        <TransportFields t={t} set={setT} issueDate={issueDate} />
        {local.some((i) => i.field !== 'transport.vehicleNo' || !t.vehicleNo.trim()) && t.distanceKm ? <ul className="list-inside list-disc text-sm text-warning">{local.filter((i) => i.field !== 'transport.vehicleNo' || !t.vehicleNo.trim()).map((i) => <li key={i.field}>{i.message}</li>)}</ul> : null}
        <ErrorBox title="JSON not ready" error={json.error} />
        <div className="flex justify-end">
          <Button variant="secondary" loading={json.isPending} disabled={!!local.length} onClick={() => json.mutate()}>Download JSON for the portal</Button>
        </div>
        <form className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <p className="text-sm font-medium sm:col-span-2">After the portal generates it</p>
          <Field label="E-way bill number" error={number && !/^[0-9]{12}$/.test(number) ? 'Twelve digits' : undefined}>
            {(p) => <Input {...p} className="num" inputMode="numeric" maxLength={12} value={number} onChange={(e) => /^\d{0,12}$/.test(e.target.value) && setNumber(e.target.value)} />}
          </Field>
          <Field label="Generated at (IST)">{(p) => <Input {...p} type="datetime-local" value={generatedAt} onChange={(e) => setGeneratedAt(e.target.value)} />}</Field>
          {t.mode ? (
            <Field label="Valid until (IST)" hint={expected ? `Rule 138(10) gives ${expected.replace('T', ' ')} for this distance; enter the portal’s time if it differs.` : undefined}>
              {(p) => <Input {...p} type="datetime-local" value={validUntil || expected} onChange={(e) => setValidUntil(e.target.value)} />}
            </Field>
          ) : (
            <p className="self-end pb-2 text-sm text-fg-muted">Part A only: no validity until the vehicle is added.</p>
          )}
          <div className="sm:col-span-2"><ErrorBox title="Not recorded" error={save.error} /></div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending} disabled={!!local.length || !/^[0-9]{12}$/.test(number) || !generatedAt}>Record e-way bill</Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function VehicleDialog({ orgId, documentId, b, onClose, onDone }: { orgId: string; documentId: string; b: EWayBillRecord; onClose: () => void; onDone: () => Promise<void> }) {
  const states = useGstStates();
  const first = !b.partB;
  const [mode, setMode] = useState<TransportMode>(b.partB?.mode ?? 'ROAD');
  const [vehicleNo, setVehicleNo] = useState('');
  const [transDocNo, setTransDocNo] = useState('');
  const [transDocDate, setTransDocDate] = useState('');
  const [fromPlace, setFromPlace] = useState('');
  const [fromStateCode, setFromStateCode] = useState('');
  const [reason, setReason] = useState(first ? '4' : '1');
  const [remark, setRemark] = useState(first ? 'First vehicle' : '');
  const [updatedAt, setUpdatedAt] = useState(nowIst());
  const expected = first && updatedAt ? toIst(expectedValidUntil(fromIst(updatedAt), b.distanceKm, b.vehicleType)) : '';
  const [validUntil, setValidUntil] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<EWayBillRecord>(`/v1/orgs/${orgId}/e-way-bills/documents/${documentId}/e-way-bill/vehicle`, {
        method: 'POST',
        body: { updatedAt: fromIst(updatedAt), mode, vehicleNo: vehicleNo || null, transDocNo: transDocNo || null, transDocDate: transDocDate || null, fromPlace, fromStateCode, reason, remark, validUntil: first ? fromIst(validUntil || expected) : null },
      }),
    onSuccess: async () => {
      onClose();
      await onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={first ? 'Add the vehicle (Part B)' : 'Change the vehicle'}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-sm text-fg-muted sm:col-span-2">Update Part B on the portal first, then record it here. {first ? 'The first Part B starts the validity.' : 'Validity does not change with a new vehicle.'}</p>
        <Field label="Mode of transport">
          {(p) => <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as TransportMode)}>{MODES.filter((m) => m.value).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>}
        </Field>
        {mode === 'ROAD' || mode === 'SHIP' ? (
          <Field label={mode === 'SHIP' ? 'Vessel number' : 'Vehicle number'} error={mode === 'ROAD' && vehicleNo ? (vehicleNoIssue(vehicleNo) ?? undefined) : undefined}>
            {(p) => <Input {...p} className="num uppercase" maxLength={20} value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value.toUpperCase())} />}
          </Field>
        ) : (
          <Field label="Transport document number">{(p) => <Input {...p} maxLength={15} value={transDocNo} onChange={(e) => setTransDocNo(e.target.value)} />}</Field>
        )}
        {mode !== 'ROAD' ? <Field label="Transport document date">{(p) => <Input {...p} type="date" value={transDocDate} onChange={(e) => setTransDocDate(e.target.value)} />}</Field> : null}
        <Field label="Place of change">{(p) => <Input {...p} maxLength={50} value={fromPlace} onChange={(e) => setFromPlace(e.target.value)} />}</Field>
        <Field label="State">
          {(p) => (
            <Select {...p} value={fromStateCode} onChange={(e) => setFromStateCode(e.target.value)}>
              <option value="">Choose…</option>
              {(states.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Reason">
          {(p) => (
            <Select {...p} value={reason} disabled={first} onChange={(e) => setReason(e.target.value)}>
              {first ? <option value="4">First time</option> : null}
              <option value="1">Breakdown</option>
              <option value="2">Transhipment</option>
              <option value="3">Others</option>
            </Select>
          )}
        </Field>
        <Field label="Remark">{(p) => <Input {...p} maxLength={50} value={remark} onChange={(e) => setRemark(e.target.value)} />}</Field>
        <Field label="Updated at (IST)">{(p) => <Input {...p} type="datetime-local" value={updatedAt} onChange={(e) => setUpdatedAt(e.target.value)} />}</Field>
        {first ? (
          <Field label="Valid until (IST)" hint={`Rule 138(10) gives ${expected.replace('T', ' ')} for ${b.distanceKm} km; enter the portal’s time if it differs.`}>
            {(p) => <Input {...p} type="datetime-local" value={validUntil || expected} onChange={(e) => setValidUntil(e.target.value)} />}
          </Field>
        ) : null}
        <div className="sm:col-span-2"><ErrorBox title="Not recorded" error={save.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!fromPlace.trim() || !fromStateCode || !remark.trim()}>Record Part B</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ orgId, documentId, b, onClose, onDone }: { orgId: string; documentId: string; b: EWayBillRecord; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('3');
  const [remark, setRemark] = useState('');
  const cancel = useMutation({
    mutationFn: () => api<EWayBillRecord>(`/v1/orgs/${orgId}/e-way-bills/documents/${documentId}/e-way-bill/cancel`, { method: 'POST', body: { reason, remark } }),
    onSuccess: async () => {
      onClose();
      await onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Record the e-way bill cancellation">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
        <p className="text-sm text-fg-muted">Cancel e-way bill <span className="num">{b.number}</span> on the portal first; it allows that until {istTime(b.cancellableUntil)}, and not once an officer has verified it. Then record it here.</p>
        <Field label="Reason">
          {(p) => (
            <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="1">Duplicate</option>
              <option value="2">Order cancelled</option>
              <option value="3">Data entry mistake</option>
              <option value="4">Others</option>
            </Select>
          )}
        </Field>
        <Field label="Remark" hint="As entered on the portal, up to 50 characters.">{(p) => <Input {...p} maxLength={50} value={remark} onChange={(e) => setRemark(e.target.value)} />}</Field>
        <ErrorBox title="Not recorded" error={cancel.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Back</Button>
          <Button type="submit" variant="danger" loading={cancel.isPending} disabled={remark.trim().length < 3}>Record cancellation</Button>
        </div>
      </form>
    </Dialog>
  );
}

export const consignmentLabel = (v: string) => money(v, 'INR');
