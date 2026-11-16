'use client';
import { useQuery } from '@tanstack/react-query';
import { REGISTRATION_STATUS_LABEL } from '@talk2tax/tax-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { IssueList } from '@/components/supplier-tax/issue-list';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { SupplierIssueRow, Verification } from '@/lib/supplier-tax';

interface Report {
  asOf: string;
  billsFrom: string;
  totals: { vendors: number; withHigh: number; withIssues: number; clean: number; verified: number; registered: number };
  vendors: { id: string; name: string; gstin: string | null; pan: string | null; verification: Verification | null; billCount: number; high: number; medium: number; low: number; issues: SupplierIssueRow[] }[];
}

/** Purchases → Supplier tax checks (AP-019): every active vendor's GST and PAN details checked. */
export default function SupplierTaxPage() {
  const { org, orgId } = useOrg();
  const [show, setShow] = useState<'issues' | 'high' | 'all'>('issues');
  const q = useQuery({ queryKey: ['supplier-tax', orgId, 'report'], queryFn: () => api<Report>(`/v1/orgs/${orgId}/purchases/supplier-tax`) });
  if (!org) return null;
  const r = q.data;
  const rows = r ? r.vendors.filter((v) => (show === 'all' ? true : show === 'high' ? v.high > 0 : v.issues.length > 0)) : [];
  return (
    <>
      <PageHeader title="Supplier tax checks" description="Each active vendor's GSTIN and PAN checked against each other, against other vendors and against the GST on their bills of the last twelve months, with what the GST portal showed when someone looked the GSTIN up. Problems here put input tax credit or TDS at risk." />
      <ErrorAlert title="Could not load the supplier tax checks" error={q.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-4"><p className="text-sm text-fg-muted">Active vendors</p><p className="mt-1 text-2xl font-semibold">{r.totals.vendors}</p><p className="text-xs text-fg-muted">{r.totals.registered} with a GSTIN</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">With a serious problem</p><p className={`mt-1 text-2xl font-semibold ${r.totals.withHigh ? 'text-negative' : ''}`}>{r.totals.withHigh}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">With anything to look at</p><p className="mt-1 text-2xl font-semibold">{r.totals.withIssues}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">GSTIN checked on the portal</p><p className="mt-1 text-2xl font-semibold">{r.totals.verified} <span className="text-base text-fg-muted">of {r.totals.registered}</span></p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Vendors">
          <CardHeader
            title="Vendors to look at"
            description={`Bills from ${date(r.billsFrom)} to ${date(r.asOf)}. Open a vendor to record a GST portal check or fix their details.`}
            actions={
              <Select aria-label="Which vendors" value={show} onChange={(e) => setShow(e.target.value as 'issues' | 'high' | 'all')}>
                <option value="issues">With anything to look at</option>
                <option value="high">With a serious problem</option>
                <option value="all">All active vendors</option>
              </Select>
            }
          />
          {rows.length ? (
            <Table>
              <thead><Tr><Th>Vendor</Th><Th>GST registration</Th><Th numeric>Bills</Th><Th>What was found</Th></Tr></thead>
              <tbody>
                {rows.map((v) => (
                  <Tr key={v.id}>
                    <Td className="align-top"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors/${v.id}`}>{v.name}</Link><span className="block num text-xs text-fg-muted">{v.gstin ?? (v.pan ? `PAN ${v.pan}` : 'Unregistered')}</span></Td>
                    <Td className="align-top text-sm">{v.verification ? <>{REGISTRATION_STATUS_LABEL[v.verification.status]}<span className="block text-xs text-fg-muted">checked {date(v.verification.checkedOn)}</span></> : v.gstin ? <span className="text-fg-muted">Not checked</span> : '—'}</Td>
                    <Td numeric className="align-top">{v.billCount}</Td>
                    <Td>{v.issues.length ? <IssueList orgId={orgId} issues={v.issues} /> : <Badge tone="positive">No problems</Badge>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title={show === 'all' ? 'No active vendors' : 'Nothing to look at'}>{show === 'all' ? 'Add vendors under Purchases → Vendors.' : 'Every active vendor passed the checks.'}</EmptyState>}
        </Card>
      ) : null}
    </>
  );
}
