'use client';
import { useQuery } from '@tanstack/react-query';
import { renderInvoiceDocument } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Field, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { InvoiceFrame, type InvoiceFrameHandle } from '@/components/invoice-templates/invoice-frame';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { ProFormaPrintData } from '@/lib/invoice-templates';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function PrintProFormaPage() {
  const { org, orgId } = useOrg();
  const { proFormaId } = useParams<{ proFormaId: string }>();
  const frame = useRef<InvoiceFrameHandle>(null);
  const [templateId, setTemplateId] = useState('');
  const q = useQuery({ queryKey: ['pro-formas', orgId, 'print', proFormaId, templateId], queryFn: () => api<ProFormaPrintData>(`/v1/orgs/${orgId}/sales/pro-formas/${proFormaId}/print${templateId ? `?templateId=${templateId}` : ''}`) });
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
  if (!d) return <ErrorAlert title="Could not load the pro forma invoice" error={q.error} />;
  return (
    <>
      <PageHeader
        title={`Print pro forma invoice ${d.proForma.status === 'DRAFT' ? '(draft)' : d.proForma.reference}`}
        description={<>For {d.proForma.contactName}. Printed with your invoice template, headed Pro forma invoice and marked as not a tax invoice. Print, or choose Save as PDF in the print dialog.</>}
        actions={
          <>
            <Link href={`/orgs/${orgId}/sales/pro-formas/${proFormaId}`}><Button variant="ghost">Back to the pro forma invoice</Button></Link>
            <Button disabled={!!rendered.error} onClick={() => frame.current?.print()}>Print or save as PDF</Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {rendered.error ? <Alert title="This template cannot render">{rendered.error}</Alert> : <InvoiceFrame ref={frame} html={rendered.html} title={`Pro forma invoice ${d.proForma.reference}`} />}
        </div>
        <Card className="h-fit p-4">
          <CardHeader title="Template" description={d.template.builtIn ? 'No template yet: printing with the built-in one for your country.' : undefined} />
          <Field label="Print with">
            {(p) => (
              <Select {...p} value={templateId || (d.template.id ?? '')} onChange={(e) => setTemplateId(e.target.value)} disabled={!d.templates.length}>
                {d.template.builtIn ? <option value="">{d.template.name}</option> : null}
                {d.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}{t.engine === 'HTML' ? ' · HTML' : ''}</option>)}
              </Select>
            )}
          </Field>
          {can(org.role, 'templates.manage') ? <Link className="mt-2 block text-sm text-accent hover:underline" href={`/orgs/${orgId}/settings/invoice-templates`}>Manage invoice templates</Link> : null}
        </Card>
      </div>
    </>
  );
}
