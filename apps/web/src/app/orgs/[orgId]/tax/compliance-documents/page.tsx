'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { COMPLIANCE_DOC_KIND_LABEL, COMPLIANCE_DOC_KINDS, type ComplianceDocKind } from '@talk2tax/tax-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import type { ComplianceDocument } from '@/components/tax/compliance-documents';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Obligation { key: string; name: string; periodLabel: string; dueDate: string; status: string; expects: ComplianceDocKind }
interface Gaps { configured: boolean; days: number; done: number; complete: number; items: { key: string; name: string; periodLabel: string; dueDate: string; needs: ComplianceDocKind; needsLabel: string; emptyRecord: boolean }[] }

/** Tax → Compliance documents (TAX-025): acknowledgements, challans and other records behind the compliance calendar. */
export default function ComplianceDocumentsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const base = `/v1/orgs/${orgId}/compliance/documents`;
  const [filter, setFilter] = useState<'' | ComplianceDocKind>('');
  const [kind, setKind] = useState<ComplianceDocKind>('ACKNOWLEDGEMENT');
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const list = useQuery({ queryKey: ['compliance-documents', orgId, filter], queryFn: () => api<{ canManage: boolean; items: ComplianceDocument[] }>(`${base}${filter ? `?kind=${filter}` : ''}`) });
  const obligations = useQuery({ queryKey: ['compliance-document-obligations', orgId], queryFn: () => api<Obligation[]>(`${base}/obligations`) });
  const gaps = useQuery({ queryKey: ['compliance-document-gaps', orgId], queryFn: () => api<Gaps>(`${base}/gaps`) });
  const add = useMutation({
    mutationFn: () => api<ComplianceDocument>(base, { method: 'POST', body: { kind, obligationKey: key || null, title, reference: reference || null, note: note || null } }),
    onSuccess: (d) => router.push(`/orgs/${orgId}/tax/compliance-documents/${d.id}`),
  });
  const pick = (k: string) => {
    setKey(k);
    const o = obligations.data?.find((x) => x.key === k);
    if (o) {
      setKind(o.expects);
      setTitle(`${o.name} ${o.periodLabel}: ${COMPLIANCE_DOC_KIND_LABEL[o.expects].toLowerCase()}`);
    }
  };
  if (!org) return null;
  const canManage = list.data?.canManage ?? false;
  const g = gaps.data;
  return (
    <>
      <PageHeader
        title="Compliance documents"
        description="The acknowledgements, challans, copies of returns, working papers, registration certificates and notices behind your compliance calendar, each linked to its return or payment with the files attached, and the date to keep it until. Returns marked filed and payments made without their acknowledgement or challan are listed so nothing is missing when a notice or audit comes."
        actions={<div className="w-56"><Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as '' | ComplianceDocKind)}><option value="">All documents</option>{COMPLIANCE_DOC_KINDS.map((k) => <option key={k} value={k}>{COMPLIANCE_DOC_KIND_LABEL[k]}</option>)}</Select></div>}
      />
      <ErrorAlert title="Could not load compliance documents" error={list.error ?? gaps.error} />
      {g ? (
        <Card role="region" aria-label="Missing documents">
          <CardHeader title="Missing documents" description={g.configured ? `${g.complete} of ${g.done} returns filed and payments made in the last year have their acknowledgement or challan on file.` : 'Set up GST, TDS/TCS or payroll first; the deadlines come from the compliance calendar.'} />
          {g.items.length ? (
            <Table aria-label="Missing documents">
              <thead><Tr><Th>Due</Th><Th>Return or payment</Th><Th>Needs</Th><Th /></Tr></thead>
              <tbody>
                {g.items.map((i) => (
                  <Tr key={i.key}>
                    <Td>{date(i.dueDate)}</Td>
                    <Td>{i.name}<span className="block text-xs text-fg-muted">{i.periodLabel}</span></Td>
                    <Td>{i.needsLabel}{i.emptyRecord ? <span className="block text-xs text-warning">Record added, no file attached</span> : null}</Td>
                    <Td>{canManage ? <Button size="sm" variant="secondary" onClick={() => { pick(i.key); document.getElementById('add-compliance-document')?.scrollIntoView({ behavior: 'smooth' }); }}>Add {i.needsLabel.toLowerCase()}</Button> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : g.configured ? <EmptyState title="Nothing missing">Every return filed and payment made has its document on file.</EmptyState> : null}
        </Card>
      ) : null}
      {canManage ? (
        <Card className="mt-6" role="region" aria-label="Add a compliance document" id="add-compliance-document">
          <CardHeader title="Add a compliance document" description="Choose the return or payment it belongs to (or none, for a registration certificate), then attach the file on the next screen." />
          <form className="grid gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="Return or payment">{(p) => <Select {...p} value={key} onChange={(e) => pick(e.target.value)}><option value="">Not linked to one</option>{(obligations.data ?? []).map((o) => <option key={o.key} value={o.key}>{o.name}, {o.periodLabel} (due {date(o.dueDate)})</option>)}</Select>}</Field>
            <Field label="Kind of document">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as ComplianceDocKind)}>{COMPLIANCE_DOC_KINDS.map((k) => <option key={k} value={k}>{COMPLIANCE_DOC_KIND_LABEL[k]}</option>)}</Select>}</Field>
            <Field label="Title">{(p) => <Input {...p} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label="Reference" hint="ARN, CIN or challan number">{(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
            <div className="sm:col-span-2"><Field label="Note" hint="Optional">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field></div>
            <div className="sm:col-span-2"><Button type="submit" loading={add.isPending}>Add document</Button></div>
          </form>
          <div className="px-4 pb-4"><ErrorAlert title="The document was not added" error={add.error} /></div>
        </Card>
      ) : null}
      <Card className="mt-6" role="region" aria-label="Documents on file">
        <CardHeader title="Documents on file" description="Newest first. Open one to see or attach its files." />
        {list.data?.items.length ? (
          <Table aria-label="Documents on file">
            <thead><Tr><Th>Document</Th><Th>Kind</Th><Th>Return or payment</Th><Th>Files</Th><Th>Keep until</Th></Tr></thead>
            <tbody>
              {list.data.items.map((d) => (
                <Tr key={d.id}>
                  <Td><Link className="text-accent" href={`/orgs/${orgId}/tax/compliance-documents/${d.id}`}>{d.reference}</Link> {d.title}{d.documentReference ? <span className="block text-xs text-fg-muted">{d.documentReference}</span> : null}</Td>
                  <Td><Badge tone="neutral">{d.kindLabel}</Badge></Td>
                  <Td>{d.obligation ? <>{d.obligation.name}<span className="block text-xs text-fg-muted">{d.obligation.periodLabel}</span></> : <span className="text-fg-muted">Organisation</span>}</Td>
                  <Td>{d.files.length ? d.files.map((f) => f.fileName).join(', ') : <span className="text-warning">No file yet</span>}</Td>
                  <Td>{d.retainUntil ? date(d.retainUntil) : 'While registered'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="No documents yet">{canManage ? 'Add the first one above.' : 'Nothing has been added yet.'}</EmptyState> : null}
      </Card>
    </>
  );
}
