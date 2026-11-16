'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { renderInvoiceDocument } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { InvoiceFrame, type InvoiceFrameHandle } from '@/components/invoice-templates/invoice-frame';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { MySignature, PrintData } from '@/lib/invoice-templates';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const VERIFY_TONE = { VALID: 'positive', CHANGED: 'negative', VOIDED: 'warning' } as const;
const VERIFY_LABEL = { VALID: 'Signature valid', CHANGED: 'Changed since signing', VOIDED: 'Voided after signing' } as const;

export default function PrintInvoicePage() {
  const { org, orgId } = useOrg();
  const { documentId } = useParams<{ documentId: string }>();
  const qc = useQueryClient();
  const frame = useRef<InvoiceFrameHandle>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const key = ['invoice-print', orgId, documentId, templateId];
  const q = useQuery({ queryKey: key, queryFn: () => api<PrintData>(`/v1/orgs/${orgId}/invoice-print/${documentId}${templateId ? `?templateId=${templateId}` : ''}`) });
  const canSign = !!org && can(org.role, 'documents.sign');
  const mine = useQuery({ queryKey: ['my-signature', orgId], queryFn: () => api<MySignature>(`/v1/orgs/${orgId}/signatures/me`), enabled: canSign });
  const refresh = (d: PrintData) => {
    qc.setQueryData(key, d);
    void qc.invalidateQueries({ queryKey: ['invoice-print', orgId, documentId] });
    void qc.invalidateQueries({ queryKey: ['my-signature', orgId] });
  };
  const choose = useMutation({ mutationFn: (id: string | null) => api<PrintData>(`/v1/orgs/${orgId}/invoice-print/${documentId}/template`, { method: 'PUT', body: { templateId: id } }), onSuccess: (d) => { setTemplateId(''); refresh(d); } });
  const sign = useMutation({ mutationFn: () => api<PrintData>(`/v1/orgs/${orgId}/invoice-print/${documentId}/signature`, { method: 'POST' }), onSuccess: refresh });
  const withdraw = useMutation({
    mutationFn: () => api<PrintData>(`/v1/orgs/${orgId}/invoice-print/${documentId}/signature/withdraw`, { method: 'POST', body: { reason } }),
    onSuccess: (d) => { setWithdrawing(false); setReason(''); refresh(d); },
  });

  const d = q.data;
  const rendered = useMemo(() => {
    if (!d) return { html: '', error: null as string | null };
    try {
      return { html: renderInvoiceDocument({ engine: d.template.engine, layout: d.template.layout, html: d.template.html }, d.source), error: null };
    } catch (e) {
      return { html: '', error: (e as Error).message };
    }
  }, [d]);

  if (!org) return null;
  if (!d) return <ErrorAlert title="Could not load the invoice" error={q.error} />;
  const label = d.document.kind === 'CREDIT_NOTE' ? 'Credit note' : 'Invoice';
  const detailPath = 'sales/invoices';
  const showing = d.template.id ?? '';
  const own = d.document.templateId ?? '';
  const sig = d.signature;
  const downloadHref = `/api/t2t/v1/orgs/${orgId}/invoice-print/${documentId}/html?download=1${templateId ? `&templateId=${templateId}` : ''}`;
  return (
    <>
      <PageHeader
        title={`Print ${label.toLowerCase()} ${d.document.number ?? '(draft)'}`}
        description={<>For {d.document.contactName}. Print, or choose Save as PDF in the print dialog.</>}
        actions={
          <>
            <Link href={`/orgs/${orgId}/${detailPath}/${documentId}`}><Button variant="ghost">Back to the {label.toLowerCase()}</Button></Link>
            <a href={downloadHref}><Button variant="secondary">Download HTML</Button></a>
            <Button disabled={!!rendered.error} onClick={() => frame.current?.print()}>Print or save as PDF</Button>
          </>
        }
      />
      <ErrorAlert title="That did not work" error={choose.error ?? sign.error ?? withdraw.error} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {rendered.error ? <Alert title="This template cannot render">{rendered.error}</Alert> : <InvoiceFrame ref={frame} html={rendered.html} title={`${label} ${d.document.number ?? ''}`} />}
        </div>
        <div className="space-y-4">
          <Card className="p-4">
            <CardHeader title="Template" description={d.template.builtIn ? 'No template yet: printing with the built-in one for your country.' : undefined} />
            <Field label="Print with">
              {(p) => (
                <Select {...p} value={templateId || showing} onChange={(e) => setTemplateId(e.target.value)} disabled={!d.templates.length}>
                  {d.template.builtIn ? <option value="">{d.template.name}</option> : null}
                  {d.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}{t.engine === 'HTML' ? ' · HTML' : ''}</option>)}
                </Select>
              )}
            </Field>
            <div className="mt-3 flex flex-wrap gap-2">
              {can(org.role, 'sales.manage') && d.document.status !== 'VOID' && showing && showing !== own ? (
                <Button size="sm" variant="secondary" loading={choose.isPending} onClick={() => choose.mutate(showing)}>Always print this {label.toLowerCase()} with it</Button>
              ) : null}
              {can(org.role, 'sales.manage') && d.document.status !== 'VOID' && own ? (
                <Button size="sm" variant="ghost" loading={choose.isPending} onClick={() => choose.mutate(null)}>Use the default instead</Button>
              ) : null}
            </div>
            {own ? <p className="mt-2 text-xs text-fg-muted">This {label.toLowerCase()} is set to print with {d.templates.find((t) => t.id === own)?.name ?? 'its own template'}.</p> : null}
            {can(org.role, 'templates.manage') ? (
              <Link className="mt-2 block text-sm text-accent hover:underline" href={d.template.id ? `/orgs/${orgId}/settings/invoice-templates/${d.template.id}` : `/orgs/${orgId}/settings/invoice-templates`}>
                {d.template.id ? 'Edit this template' : 'Create a template'}
              </Link>
            ) : null}
          </Card>

          <Card className="p-4">
            <CardHeader
              title="E-signature"
              actions={sig.verification ? <Badge tone={VERIFY_TONE[sig.verification.status]}>{VERIFY_LABEL[sig.verification.status]}</Badge> : null}
            />
            {sig.current ? (
              <div className="space-y-2 text-sm">
                <img src={sig.current.imageDataUrl} alt={`Signature of ${sig.current.signerName}`} className="max-h-16 rounded border border-line bg-white p-1" />
                <div className="text-fg">{sig.current.signerName}{sig.current.designation ? `, ${sig.current.designation}` : ''}</div>
                <div className="text-xs text-fg-muted">Signed {date(sig.current.signedAt.slice(0, 10))} at {sig.current.signedAt.slice(11, 16)} UTC by {sig.current.signedByName}</div>
                <div className="break-all font-mono text-[11px] text-fg-faint" title="SHA-256 of the invoice's number, dates, customer, lines and totals when it was signed">Hash {sig.current.contentHash}</div>
                {sig.verification ? <p className="text-xs text-fg-muted">{sig.verification.message}</p> : null}
                {canSign && d.document.status === 'POSTED' ? (
                  withdrawing ? (
                    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); withdraw.mutate(); }}>
                      <Field label="Why withdraw the signature?">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required />}</Field>
                      <div className="flex gap-2"><Button size="sm" variant="danger" type="submit" loading={withdraw.isPending}>Withdraw signature</Button><Button size="sm" variant="ghost" type="button" onClick={() => setWithdrawing(false)}>Cancel</Button></div>
                    </form>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setWithdrawing(true)}>Withdraw…</Button>
                  )
                ) : null}
              </div>
            ) : d.document.status !== 'POSTED' ? (
              <p className="text-sm text-fg-muted">{d.document.status === 'DRAFT' ? 'Post the invoice before signing it: a draft can still change.' : 'A void invoice cannot be signed.'}</p>
            ) : !canSign ? (
              <p className="text-sm text-fg-muted">Not signed. Your role cannot sign invoices.</p>
            ) : mine.data && !mine.data.signature ? (
              <p className="text-sm text-fg-muted">Not signed. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/signature`}>Save your signature</Link> first.</p>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="text-fg-muted">Not signed. Signing places your saved signature on the {label.toLowerCase()} and records a SHA-256 hash of its contents, so any later change shows.</p>
                {mine.data?.signature ? <img src={mine.data.signature.imageDataUrl} alt="Your signature" className="max-h-12 rounded border border-line bg-white p-1" /> : null}
                <Button size="sm" loading={sign.isPending} disabled={!mine.data?.signature} onClick={() => sign.mutate()}>Sign as {mine.data?.signature?.signerName ?? '…'}</Button>
              </div>
            )}
            {sig.history.some((h) => h.withdrawnAt) ? (
              <details className="mt-3 text-xs text-fg-muted">
                <summary className="cursor-pointer">Earlier signatures</summary>
                <ul className="mt-1 space-y-1">
                  {sig.history.filter((h) => h.withdrawnAt).map((h) => (
                    <li key={h.id}>{h.signerName}, signed {date(h.signedAt.slice(0, 10))}; withdrawn by {h.withdrawnByName} on {date(h.withdrawnAt!.slice(0, 10))}: {h.withdrawReason}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p className="mt-3 text-[11px] leading-4 text-fg-faint">This is an electronic signature with tamper evidence. Aadhaar eSign or a DSC (digital signature certificate) needs a licensed signing provider and is not connected yet.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
