'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GST_PORTAL_SEARCH_URL, REGISTRATION_STATUS_LABEL, REGISTRATION_STATUSES, TAXPAYER_TYPE_LABEL, TAXPAYER_TYPES, type RegistrationStatus, type TaxpayerType } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import type { SupplierIssueRow, Verification } from '@/lib/supplier-tax';
import { IssueList } from './issue-list';

interface VendorTax {
  vendor: { id: string; name: string; gstin: string | null; pan: string | null; stateCode: string | null; tdsSection: string | null };
  billsFrom: string;
  billCount: number;
  verification: Verification | null;
  issues: SupplierIssueRow[];
  checks: { id: string; gstin: string; current: boolean; status: RegistrationStatus; taxpayerType: TaxpayerType | null; legalName: string | null; effectiveDate: string | null; checkedOn: string; note: string | null; recordedBy: string }[];
}
const STATUS_TONE = { ACTIVE: 'positive', CANCELLED: 'negative', SUSPENDED: 'warning', NOT_FOUND: 'negative' } as const;

/** A vendor's tax checks (AP-019): what was found, and the GST portal checks people recorded. */
export function GstinChecksCard({ orgId, contactId, canManage }: { orgId: string; contactId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ['supplier-tax', orgId, contactId];
  const q = useQuery({ queryKey: key, queryFn: () => api<VendorTax>(`/v1/orgs/${orgId}/purchases/supplier-tax/${contactId}`) });
  const [recording, setRecording] = useState(false);
  const d = q.data;
  if (q.error) return <div className="mt-6"><Alert title="Could not load the tax checks">{q.error.message}</Alert></div>;
  if (!d) return null;
  return (
    <Card className="mt-6" role="region" aria-label="Tax checks">
      <CardHeader
        title="Tax checks"
        description={`This vendor's GSTIN and PAN checked against each other, other vendors and the GST on their bills since ${date(d.billsFrom)}, and what the GST portal showed when someone looked the GSTIN up.`}
        actions={
          d.vendor.gstin ? (
            <div className="flex items-center gap-3">
              <a className="text-sm text-accent hover:underline" href={GST_PORTAL_SEARCH_URL} target="_blank" rel="noopener noreferrer">GST portal search</a>
              {canManage ? <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>Record portal check</Button> : null}
            </div>
          ) : null
        }
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <span>GSTIN <span className="num font-medium">{d.vendor.gstin ?? 'none (unregistered)'}</span></span>
          <span>PAN <span className="num font-medium">{d.vendor.pan ?? 'none'}</span></span>
          {d.vendor.tdsSection ? <span>TDS section <span className="font-medium">{d.vendor.tdsSection}</span></span> : null}
          <span>
            Registration{' '}
            {d.verification ? (
              <><Badge tone={STATUS_TONE[d.verification.status]}>{REGISTRATION_STATUS_LABEL[d.verification.status]}</Badge> <span className="text-fg-muted">{d.verification.taxpayerType ? `${TAXPAYER_TYPE_LABEL[d.verification.taxpayerType]}, ` : ''}checked {date(d.verification.checkedOn)}</span></>
            ) : <span className="text-fg-muted">not checked on the portal</span>}
          </span>
        </div>
        {d.issues.length ? <IssueList orgId={orgId} issues={d.issues} /> : <p className="text-sm text-positive">No problems found.</p>}
        {d.checks.length ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Portal checks recorded</h3>
            <Table aria-label="Portal checks">
              <thead><Tr><Th>Checked</Th><Th>GSTIN</Th><Th>Status</Th><Th>Type</Th><Th>Legal name on the portal</Th><Th>Recorded by</Th></Tr></thead>
              <tbody>
                {d.checks.map((c) => (
                  <Tr key={c.id}>
                    <Td>{date(c.checkedOn)}</Td>
                    <Td className="num text-xs">{c.gstin}{c.current ? null : <span className="block text-fg-muted">earlier GSTIN</span>}</Td>
                    <Td><Badge tone={STATUS_TONE[c.status]}>{REGISTRATION_STATUS_LABEL[c.status]}</Badge>{c.effectiveDate ? <span className="block text-xs text-fg-muted">from {date(c.effectiveDate)}</span> : null}</Td>
                    <Td className="text-sm">{c.taxpayerType ? TAXPAYER_TYPE_LABEL[c.taxpayerType] : '—'}</Td>
                    <Td className="text-sm">{c.legalName ?? '—'}{c.note ? <span className="block text-xs text-fg-muted">{c.note}</span> : null}</Td>
                    <Td className="text-sm">{c.recordedBy}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </div>
      {recording ? <RecordDialog url={`/v1/orgs/${orgId}/purchases/supplier-tax/${contactId}/checks`} gstin={d.vendor.gstin!} onClose={() => setRecording(false)} onDone={(x) => { qc.setQueryData(key, x); void qc.invalidateQueries({ queryKey: ['supplier-tax', orgId] }); setRecording(false); }} /> : null}
    </Card>
  );
}

function RecordDialog({ url, gstin, onClose, onDone }: { url: string; gstin: string; onClose: () => void; onDone: (d: VendorTax) => void }) {
  const [f, setF] = useState({ status: 'ACTIVE' as RegistrationStatus, taxpayerType: 'REGULAR' as TaxpayerType | '', legalName: '', effectiveDate: '', checkedOn: today(), note: '' });
  const save = useMutation({
    mutationFn: () =>
      api<VendorTax>(url, {
        method: 'POST',
        body: {
          status: f.status,
          taxpayerType: f.status === 'NOT_FOUND' || !f.taxpayerType ? null : f.taxpayerType,
          legalName: f.legalName || null,
          effectiveDate: ['CANCELLED', 'SUSPENDED'].includes(f.status) && f.effectiveDate ? f.effectiveDate : null,
          checkedOn: f.checkedOn,
          note: f.note || null,
        },
      }),
    onSuccess: onDone,
  });
  const dated = f.status === 'CANCELLED' || f.status === 'SUSPENDED';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Record a portal check of ${gstin}`} description="Look the GSTIN up on the GST portal's Search Taxpayer page and record what it shows. Checks are kept as recorded; a later check replaces it.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.error ? <Alert title="Could not record the check">{save.error.message}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GSTIN status">{(p) => <Select {...p} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as RegistrationStatus })}>{REGISTRATION_STATUSES.map((s) => <option key={s} value={s}>{REGISTRATION_STATUS_LABEL[s]}</option>)}</Select>}</Field>
          <Field label="Taxpayer type">{(p) => <Select {...p} disabled={f.status === 'NOT_FOUND'} value={f.taxpayerType} onChange={(e) => setF({ ...f, taxpayerType: e.target.value as TaxpayerType | '' })}><option value="">Not shown</option>{TAXPAYER_TYPES.map((t) => <option key={t} value={t}>{TAXPAYER_TYPE_LABEL[t]}</option>)}</Select>}</Field>
          <Field label="Legal name on the portal">{(p) => <Input {...p} maxLength={200} value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} />}</Field>
          <Field label="Checked on">{(p) => <Input {...p} type="date" max={today()} required value={f.checkedOn} onChange={(e) => setF({ ...f, checkedOn: e.target.value })} />}</Field>
          {dated ? <Field label={f.status === 'CANCELLED' ? 'Cancelled from' : 'Suspended from'} hint="As the portal shows it. Bills with GST from this date are flagged.">{(p) => <Input {...p} type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />}</Field> : null}
        </div>
        <Field label="Note">{(p) => <Textarea {...p} maxLength={500} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Record check</Button>
        </div>
      </form>
    </Dialog>
  );
}
