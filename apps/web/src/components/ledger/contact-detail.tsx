'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { DateInput } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { fyStartFor } from '@/components/report-bits';
import type { LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import { can, type Contact, type DocumentSummary, type Statement } from '@/lib/types';
import { ContactDialog, draftFrom, type ContactDraft } from './contacts-page';
import { DocumentsTable } from './documents-table';
import { CustomerDeals } from '@/components/crm/customer-deals';
import { Customer360 } from '@/components/crm/customer-360';
import { VendorBankCard } from '@/components/purchases/vendor-bank-card';
import { OnboardingPanel } from '@/components/onboarding/onboarding-panel';
import { PortalLinksCard } from '@/components/customer-portal/portal-links-card';
import { VendorPortalCard } from '@/components/vendor-portal/vendor-portal-card';
import { GstinChecksCard } from '@/components/supplier-tax/gstin-checks-card';
import { VendorPerformanceCard } from '@/components/vendor-performance/performance-card';
import { VendorRiskCard } from '@/components/vendor-risk/risk-card';

export function ContactDetail({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const { contactId } = useParams<{ contactId: string }>();
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 1));
  const [to, setTo] = useState(today());
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [stCurrency, setStCurrency] = useState('');
  const qc = useQueryClient();
  const contact = useQuery({ queryKey: ['contact', orgId, contactId], queryFn: () => api<Contact>(`/v1/orgs/${orgId}/contacts/${contactId}`) });
  const statement = useQuery({
    queryKey: ['contact', orgId, contactId, 'statement', l.ledger, from, to, stCurrency],
    queryFn: () => api<Statement>(`/v1/orgs/${orgId}/contacts/${contactId}/statement?ledger=${l.ledger}&from=${from}&to=${to}${stCurrency ? `&currency=${stCurrency}` : ''}`),
  });
  const docs = useQuery({
    queryKey: ['documents', orgId, l.api, 'contact', contactId],
    queryFn: () => api<{ items: DocumentSummary[] }>(`/v1/orgs/${orgId}/${l.api}/documents?contactId=${contactId}&limit=50`),
  });
  if (!org) return null;
  if (contact.error) return <Alert title="Not found">{(contact.error as Error).message}</Alert>;
  const x = contact.data;
  if (!x) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = org.functionalCurrency;
  const bal = x[l.balanceKey];
  const canManage = can(org.role, l.managePermission);
  return (
    <>
      <PageHeader
        title={x.name}
        description={[x.email, x.phone, x.taxId ? `Tax ID ${x.taxId}` : null, `${x.paymentTermsDays} day terms`, x.creditLimit ? `credit limit ${money(x.creditLimit, org.functionalCurrency)}` : null].filter(Boolean).join(' · ')}
        actions={
          <>
            {l.ledger === 'SALES' && x.creditHold ? <Badge tone="negative">On credit hold</Badge> : null}
            {can(org.role, 'contacts.manage') ? <Button variant="ghost" onClick={() => setDraft(draftFrom(x, l))}>Edit</Button> : null}
            {canManage ? (
              <>
                <Link href={`/orgs/${orgId}/${l.paymentsPath}/new?contactId=${x.id}`}><Button variant="secondary">{l.payment.verb}</Button></Link>
                <Link href={`/orgs/${orgId}/${l.docsPath}/new?contactId=${x.id}`}><Button>New {l.charge.label.toLowerCase()}</Button></Link>
              </>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open" value={<Money value={bal.outstanding} currency={c} />} tone="accent" />
        <Stat label="Overdue" value={<Money value={bal.overdue} currency={c} />} tone="negative" />
        <Stat label="Unapplied credits" value={<Money value={bal.unapplied} currency={c} />} tone="violet" />
        <Stat label="Balance" value={<Money value={bal.balance} currency={c} signed />} tone="positive" />
      </div>
      {l.ledger === 'SALES' && x.isCustomer ? <OnboardingPanel orgId={orgId} contactId={x.id} currency={c} onChange={() => void qc.invalidateQueries({ queryKey: ['contact', orgId, contactId] })} /> : null}
      {l.ledger === 'PURCHASES' && x.isVendor ? <OnboardingPanel party="VENDOR" orgId={orgId} contactId={x.id} currency={c} onChange={() => void qc.invalidateQueries({ queryKey: ['contact', orgId, contactId] })} /> : null}
      <Card className="mt-6">
        <CardHeader
          title="Statement"
          description={statement.data && statement.data.currencies.length > 1 ? `Every posted document and payment in ${statement.data.currency}, with a running balance. Balances above are in ${c}, at each record's own rate.` : 'Every posted document and payment, with a running balance.'}
          actions={
            <div className="flex flex-wrap gap-3">
              {statement.data && statement.data.currencies.length > 1 ? (
                <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
                  Currency
                  <Select aria-label="Statement currency" value={statement.data.currency} onChange={(e) => setStCurrency(e.target.value)}>
                    {statement.data.currencies.map((x) => <option key={x} value={x}>{x}</option>)}
                  </Select>
                </label>
              ) : null}
              <DateInput label="From" value={from} onChange={setFrom} />
              <DateInput label="To" value={to} onChange={setTo} />
            </div>
          }
        />
        {statement.data ? (
          <Table>
            <thead><tr><Th>Date</Th><Th>Number</Th><Th>Details</Th><Th numeric>{l.ledger === 'SALES' ? 'Charged' : 'Billed'}</Th><Th numeric>{l.ledger === 'SALES' ? 'Paid / credited' : 'Paid / credited'}</Th><Th numeric>Balance</Th></tr></thead>
            <tbody>
              <Tr><Td colSpan={5} className="text-fg-muted">Opening balance</Td><Td numeric><Money value={statement.data.openingBalance} currency={statement.data.currency} signed /></Td></Tr>
              {statement.data.lines.map((s, i) => (
                <Tr key={`${s.id}-${s.kind}-${i}`}>
                  <Td className="whitespace-nowrap">{date(s.date)}</Td>
                  <Td className="num"><Link className="text-accent hover:underline" href={s.kind.startsWith('WRITE_OFF') ? `/orgs/${orgId}/sales/bad-debts` : `/orgs/${orgId}/${s.kind.startsWith('RECEIPT') || s.kind.startsWith('PAYMENT') ? l.paymentsPath : l.docsPath}/${s.id}`}>{s.number}</Link></Td>
                  <Td className="text-fg-muted">{s.description}</Td>
                  <Td numeric>{s.charge ? <Money value={s.charge} currency={statement.data.currency} /> : ''}</Td>
                  <Td numeric>{s.credit ? <Money value={s.credit} currency={statement.data.currency} /> : ''}</Td>
                  <Td numeric><Money value={s.balance} currency={statement.data.currency} signed /></Td>
                </Tr>
              ))}
            </tbody>
            <tfoot><tr><Td colSpan={5} className="font-semibold">Closing balance</Td><Td numeric className="font-semibold"><Money value={statement.data.closingBalance} currency={statement.data.currency} signed /></Td></tr></tfoot>
          </Table>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">Loading…</p>}
      </Card>
      <Card className="mt-6">
        <CardHeader title={`Recent ${l.charge.plural.toLowerCase()} and ${l.credit.plural.toLowerCase()}`} />
        {docs.data && docs.data.items.length === 0 ? <p className="px-5 py-4 text-sm text-fg-muted">None yet.</p> : <DocumentsTable l={l} orgId={orgId} items={docs.data?.items ?? []} currency={c} showContact={false} />}
      </Card>
      {l.ledger === 'PURCHASES' && x.isVendor ? <VendorBankCard orgId={orgId} contactId={x.id} /> : null}
      {l.ledger === 'PURCHASES' && x.isVendor && x.isActive ? <VendorRiskCard orgId={orgId} contactId={x.id} canManage={canManage} /> : null}
      {l.ledger === 'PURCHASES' && x.isVendor && x.isActive ? <GstinChecksCard orgId={orgId} contactId={x.id} canManage={canManage} /> : null}
      {l.ledger === 'PURCHASES' && x.isVendor ? <VendorPortalCard orgId={orgId} contactId={x.id} vendorName={x.name} canManage={can(org.role, 'purchases.manage')} active={x.isActive} /> : null}
      {l.ledger === 'PURCHASES' && x.isVendor ? <VendorPerformanceCard orgId={orgId} contactId={x.id} currency={c} /> : null}
      {l.ledger === 'SALES' && x.isCustomer && can(org.role, 'reports.read') ? <Customer360 orgId={orgId} contactId={x.id} currency={c} /> : null}
      {l.ledger === 'SALES' && x.isCustomer ? <PortalLinksCard orgId={orgId} contactId={x.id} customerName={x.name} canManage={can(org.role, 'sales.manage')} active={x.isActive} /> : null}
      {l.ledger === 'SALES' && x.isCustomer ? <CustomerDeals orgId={orgId} contactId={x.id} currency={c} /> : null}
      <ContactDialog l={l} draft={draft} setDraft={setDraft} />
    </>
  );
}
