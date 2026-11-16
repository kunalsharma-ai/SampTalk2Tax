'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import type { EInvoiceDocument, EInvoiceRecord, EInvoiceState } from '@/lib/types';

export const EINVOICE_STATE: Record<EInvoiceState, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' }> = {
  READY: { label: 'Ready for IRP', tone: 'accent' },
  NEEDS_DATA: { label: 'Needs details', tone: 'warning' },
  TOO_LATE: { label: 'Past 30 days', tone: 'negative' },
  GENERATED: { label: 'IRN generated', tone: 'positive' },
  CANCELLED: { label: 'IRN cancelled', tone: 'neutral' },
  NOT_REQUIRED: { label: 'Not required', tone: 'neutral' },
  UNSUPPORTED: { label: 'Not supported', tone: 'warning' },
};

/** Date and time in India, as the IRP prints it. */
export const istTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';

/** Save JSON as a file, the way the IRP's bulk upload and offline tool take it. */
export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The signed QR code exactly as the IRP returned it, drawn as a QR image. */
export function SignedQr({ value, size = 168 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: 'L', margin: 1, width: size * 2 })
      .then((u) => live && setSrc(u))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [value, size]);
  if (failed) return <p className="text-xs text-negative">The QR code is too long to draw.</p>;
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} width={size} height={size} alt="E-invoice QR code (signed by the IRP)" className="rounded border border-line bg-white p-1" /> : <div style={{ width: size, height: size }} className="rounded border border-line bg-surface-hover" />;
}

function issuesOf(e: unknown) {
  return e instanceof ApiError ? [e.message, ...e.issues] : ['Try again.'];
}

/** The e-invoice card on an invoice or credit note: state, JSON download, IRP response import, cancellation. */
export function EInvoicePanel({ orgId, documentId, canManage, onChange }: { orgId: string; documentId: string; canManage: boolean; onChange: () => Promise<void> | void }) {
  const qc = useQueryClient();
  const key = ['einvoice', orgId, documentId];
  const q = useQuery({ queryKey: key, queryFn: () => api<EInvoiceDocument>(`/v1/orgs/${orgId}/e-invoicing/documents/${documentId}`) });
  const [importOpen, setImportOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('2');
  const [remark, setRemark] = useState('');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['einvoice', orgId] });
    await onChange();
  };
  const json = useMutation({
    mutationFn: () => api<Record<string, unknown>>(`/v1/orgs/${orgId}/e-invoicing/documents/${documentId}/json`),
    onSuccess: (p) => downloadJson(`${String((p.DocDtls as { No?: string })?.No ?? documentId).replace(/[^A-Za-z0-9-]/g, '_')}-einvoice.json`, p),
  });
  const parsed = (() => {
    if (!raw.trim()) return { value: null, error: null };
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? { value: v as Record<string, unknown>, error: null } : { value: null, error: 'Paste one JSON object, the response for this document' };
    } catch {
      return { value: null, error: 'This is not valid JSON' };
    }
  })();
  const importIrn = useMutation({
    mutationFn: () => api<EInvoiceRecord>(`/v1/orgs/${orgId}/e-invoicing/documents/${documentId}/irn`, { method: 'POST', body: { response: parsed.value } }),
    onSuccess: async () => {
      setImportOpen(false);
      setRaw('');
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<EInvoiceRecord>(`/v1/orgs/${orgId}/e-invoicing/documents/${documentId}/irn/cancel`, { method: 'POST', body: { reason, remark } }),
    onSuccess: async () => {
      setCancelOpen(false);
      await refresh();
    },
  });

  const d = q.data;
  if (!d) return null;
  if (!d.configured) return null;
  if (d.state === 'NOT_REQUIRED' && !d.history.length) return null;
  const s = EINVOICE_STATE[d.state];
  const live = d.state === 'GENERATED' ? d.eInvoice : null;
  const canCancel = live && Date.parse(live.cancellableUntil) > Date.now();

  return (
    <Card className="mt-6" aria-label="E-invoice">
      <CardHeader
        title={<span className="flex items-center gap-2">E-invoice <Badge tone={s.tone}>{s.label}</Badge></span>}
        description={d.reason}
        actions={
          <div className="flex flex-wrap gap-2">
            {d.state === 'READY' ? <Button variant="secondary" size="sm" loading={json.isPending} onClick={() => json.mutate()}>Download JSON for IRP</Button> : null}
            {canManage && (d.state === 'READY' || d.state === 'TOO_LATE') ? <Button size="sm" onClick={() => { importIrn.reset(); setImportOpen(true); }}>Import IRP response…</Button> : null}
            {canManage && canCancel ? <Button variant="ghost" size="sm" onClick={() => { cancel.reset(); setRemark(''); setCancelOpen(true); }}>Record IRN cancellation…</Button> : null}
          </div>
        }
      />
      {json.error ? <div className="px-5 pt-4"><Alert title="JSON not ready">{issuesOf(json.error).join(' · ')}</Alert></div> : null}
      {d.state === 'NEEDS_DATA' ? (
        <ul className="list-inside list-disc px-5 py-4 text-sm text-warning">
          {d.issues.map((i) => <li key={`${i.field}${i.message}`}>{i.message}</li>)}
          <li className="list-none pt-2 text-fg-muted">
            Fix these on the <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${d.contact.id}`}>customer</Link> or in the <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/e-invoicing`}>e-invoicing settings</Link>.
          </li>
        </ul>
      ) : null}
      {live ? <IrnDetails e={live} /> : null}
      {d.history.filter((h) => h.status === 'CANCELLED').length ? (
        <div className="border-t border-line px-5 py-3 text-sm">
          <p className="font-medium">Cancelled IRNs</p>
          <ul className="mt-1 space-y-1 text-fg-muted">
            {d.history.filter((h) => h.status === 'CANCELLED').map((h) => (
              <li key={h.id}><span className="num">{h.irn.slice(0, 16)}…</span> · acknowledged {istTime(h.ackDate)} · cancelled {istTime(h.cancelledAt!)} ({h.cancelReason}: {h.cancelRemark})</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Dialog open={importOpen} onOpenChange={setImportOpen} title="Import the IRP response">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); importIrn.mutate(); }}>
          <p className="text-sm text-fg-muted">
            Upload the JSON to the IRP (einvoice1.gst.gov.in or your GSP), then paste the response for this document here. Talk2Tax checks that the signed QR code is for this invoice: seller, buyer, number, type, date and total.
          </p>
          <Field label="IRP response (JSON)" error={parsed.error ?? undefined} hint="Contains Irn, AckNo, AckDt, SignedInvoice and SignedQRCode.">
            {(p) => <Textarea {...p} rows={8} className="num text-xs" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder='{"Irn": "…", "AckNo": …, "AckDt": "…", "SignedInvoice": "…", "SignedQRCode": "…"}' />}
          </Field>
          {importIrn.error ? <Alert title="Not recorded">{issuesOf(importIrn.error)[0]}{issuesOf(importIrn.error).length > 1 ? <ul className="mt-1 list-inside list-disc">{issuesOf(importIrn.error).slice(1).map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button type="submit" loading={importIrn.isPending} disabled={!parsed.value}>Record IRN</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen} title="Record the IRN cancellation">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <p className="text-sm text-fg-muted">
            Cancel the IRN on the IRP first; the IRP allows it until {live ? istTime(live.cancellableUntil) : ''}. Then record it here. After that the invoice can be voided, or corrected and reported again with a new IRN.
          </p>
          <Field label="Reason">
            {(p) => (
              <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="1">Duplicate</option>
                <option value="2">Data entry mistake</option>
                <option value="3">Order cancelled</option>
                <option value="4">Others</option>
              </Select>
            )}
          </Field>
          <Field label="Remark" hint="As entered on the IRP, up to 100 characters.">{(p) => <Input {...p} maxLength={100} value={remark} onChange={(e) => setRemark(e.target.value)} />}</Field>
          {cancel.error ? <Alert title="Not recorded">{issuesOf(cancel.error).join(' · ')}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCancelOpen(false)}>Back</Button>
            <Button type="submit" variant="danger" loading={cancel.isPending} disabled={remark.trim().length < 3}>Record cancellation</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function IrnDetails({ e }: { e: EInvoiceRecord }) {
  return (
    <div className="grid gap-6 px-5 py-4 sm:grid-cols-[auto_1fr]">
      <SignedQr value={e.signedQrCode} />
      <dl className="grid grid-cols-[9rem_1fr] content-start gap-y-2 text-sm">
        <dt className="text-fg-muted">IRN</dt>
        <dd className="num break-all">{e.irn}</dd>
        <dt className="text-fg-muted">Ack. number</dt>
        <dd className="num">{e.ackNo}</dd>
        <dt className="text-fg-muted">Ack. date</dt>
        <dd>{istTime(e.ackDate)}</dd>
        {e.qr ? (
          <>
            <dt className="text-fg-muted">QR code says</dt>
            <dd>{e.qr.docType} {e.qr.docNo} of {e.qr.docDate} · buyer <span className="num">{e.qr.buyerGstin}</span> · total {money(e.qr.total, 'INR')}{e.qr.mainHsn ? <> · HSN {e.qr.mainHsn}</> : null}</dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Signature</dt>
        <dd>{e.signatureVerified ? <Badge tone="positive">Verified with the IRP key</Badge> : <Badge tone="warning">Not verified (no IRP key in settings)</Badge>}</dd>
        <dt className="text-fg-muted">Cancellable until</dt>
        <dd>{Date.parse(e.cancellableUntil) > Date.now() ? istTime(e.cancellableUntil) : <span className="text-fg-muted">Closed at {istTime(e.cancellableUntil)}; issue a credit note to reverse it</span>}</dd>
      </dl>
    </div>
  );
}
