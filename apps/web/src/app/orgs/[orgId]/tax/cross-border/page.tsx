'use client';
import { useQuery } from '@tanstack/react-query';
import type { CrossBorderCheckKind, CrossBorderKind } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Sums {
  net: string;
  tax: string;
  documents: number;
}
interface Report {
  from: string;
  to: string;
  currency: string;
  documents: number;
  considered: number;
  contactsWithoutCountry: number;
  home: string;
  homeInEu: boolean;
  totals: { sales: Sums; purchases: Sums; reverseCharge: Sums };
  byCountry: { country: string; countryName: string; euMember: boolean; sales: Sums; purchases: Sums; currencies: string[] }[];
  ecSalesList: { contactId: string; contactName: string; country: string; countryName: string; vatId: string | null; net: string; documents: number }[] | null;
  checks: {
    kind: CrossBorderCheckKind;
    label: string;
    message: string;
    documentId: string;
    documentKind: CrossBorderKind;
    number: string | null;
    issueDate: string;
    contactId: string;
    contactName: string;
  }[];
}
const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TONE: Record<CrossBorderCheckKind, 'warning' | 'accent'> = { EXPORT_TAXED: 'warning', INTRA_EU_NO_VAT_ID: 'warning', IMPORT_NO_REVERSE_CHARGE: 'accent', COUNTRY_MISSING: 'accent' };
const docHref = (orgId: string, kind: CrossBorderKind, id: string) => `/orgs/${orgId}/${kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? 'sales/invoices' : 'purchases/bills'}/${id}`;
const contactHref = (orgId: string, kind: CrossBorderKind, id: string) => `/orgs/${orgId}/${kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? 'sales/customers' : 'purchases/vendors'}/${id}`;
const KIND_LABEL: Record<CrossBorderKind, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit' };

/** Tax → Cross-border report (TAX-038): sales and purchases with contacts abroad, by country, with the EU recapitulative statement and what needs a second look. */
export default function CrossBorderPage() {
  const { org, orgId } = useOrg();
  const [form, setForm] = useState({ from: '', to: '' });
  const [asked, setAsked] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const qs = [asked.from ? `from=${asked.from}` : '', asked.to ? `to=${asked.to}` : ''].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['cross-border', orgId, qs], queryFn: () => api<Report>(`/v1/orgs/${orgId}/tax/cross-border?${qs}`) });
  if (!org) return null;
  const d = q.data;
  const m = (x: string) => money(x, d?.currency ?? org.functionalCurrency);
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/tax/cross-border/export?${qs}`);
      const url = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = x.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Cross-border report"
        description="Posted sales to and purchases from contacts in other countries, by country, in your books' currency. EU businesses also get the list of intra-EU supplies for the recapitulative statement. The checks point to documents whose treatment usually needs a second look; they are general guidance, not advice."
        actions={
          <Button variant="secondary" size="sm" loading={busy} disabled={!d} onClick={() => void download()}>
            Download cross-border report (CSV)
          </Button>
        }
      />
      <form
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked({ from: ISO.test(form.from) ? form.from : '', to: ISO.test(form.to) ? form.to : '' });
        }}
      >
        <Field label="From">{(p) => <Input {...p} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
        <Field label="To date">{(p) => <Input {...p} type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      <ErrorAlert title="Could not build the cross-border report" error={q.error} />
      {d ? (
        <>
          <p className="mb-4 text-sm text-fg-muted">
            {date(d.from)} to {date(d.to)}: {d.considered} of {d.documents} posted documents are with contacts abroad.
          </p>
          {d.contactsWithoutCountry ? (
            <Alert tone="accent" title={`${d.contactsWithoutCountry} active contact${d.contactsWithoutCountry === 1 ? ' has' : 's have'} no country`}>
              Documents are reported under the contact&apos;s country. Set the country on each customer and vendor (Sales, Customers or Purchases, Vendors) so nothing abroad is missed.
            </Alert>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-sm text-fg-muted">Sales abroad</p>
              <p className="mt-1 text-2xl font-semibold">{m(d.totals.sales.net)}</p>
              <p className="text-xs text-fg-muted">
                {d.totals.sales.documents} documents, tax {m(d.totals.sales.tax)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-fg-muted">Purchases from abroad</p>
              <p className="mt-1 text-2xl font-semibold">{m(d.totals.purchases.net)}</p>
              <p className="text-xs text-fg-muted">
                {d.totals.purchases.documents} documents, reverse charge on {m(d.totals.reverseCharge.net)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-fg-muted">To look at</p>
              <p className={`mt-1 text-2xl font-semibold ${d.checks.length ? 'text-warning' : ''}`}>{d.checks.length}</p>
              <p className="text-xs text-fg-muted">Documents flagged below</p>
            </Card>
          </div>

          <Card className="mt-6" role="region" aria-label="Trade by country">
            <CardHeader title="Trade by country" description="Net of credit notes and vendor credits, before tax, converted at each document's exchange rate." />
            {d.byCountry.length ? (
              <Table aria-label="Trade by country">
                <thead>
                  <Tr>
                    <Th>Country</Th>
                    <Th className="text-right">Sales</Th>
                    <Th className="text-right">Tax on sales</Th>
                    <Th className="text-right">Purchases</Th>
                    <Th className="text-right">Tax on purchases</Th>
                    <Th>Currencies</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.byCountry.map((c) => (
                    <Tr key={c.country}>
                      <Td>
                        <span className="block">{c.countryName}</span>
                        <span className="block text-xs text-fg-muted">
                          {c.country}
                          {c.euMember ? ', EU' : ''}
                        </span>
                      </Td>
                      <Td className="text-right">
                        {m(c.sales.net)}
                        <span className="block text-xs text-fg-muted">{docs(c.sales.documents)}</span>
                      </Td>
                      <Td className="text-right">{m(c.sales.tax)}</Td>
                      <Td className="text-right">
                        {m(c.purchases.net)}
                        <span className="block text-xs text-fg-muted">{docs(c.purchases.documents)}</span>
                      </Td>
                      <Td className="text-right">{m(c.purchases.tax)}</Td>
                      <Td>{c.currencies.join(', ')}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing abroad in this period">No posted document is with a contact in another country.</EmptyState>
            )}
          </Card>

          {d.ecSalesList ? (
            <Card className="mt-6" role="region" aria-label="Recapitulative statement">
              <CardHeader
                title="Recapitulative statement"
                description="Zero-rated supplies to customers in other EU states, by customer VAT ID: the figures for the EC Sales List (Zusammenfassende Meldung in Germany). File it with your tax office; Talk2Tax does not send it."
              />
              {d.ecSalesList.length ? (
                <Table aria-label="Recapitulative statement">
                  <thead>
                    <Tr>
                      <Th>Customer</Th>
                      <Th>Country</Th>
                      <Th>VAT ID</Th>
                      <Th className="text-right">Net</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {d.ecSalesList.map((e) => (
                      <Tr key={e.contactId}>
                        <Td>
                          <Link className="underline" href={`/orgs/${orgId}/sales/customers/${e.contactId}`}>
                            {e.contactName}
                          </Link>
                        </Td>
                        <Td>{e.countryName}</Td>
                        <Td>{e.vatId ?? <Badge tone="warning">Missing</Badge>}</Td>
                        <Td className="text-right">
                          {m(e.net)}
                          <span className="block text-xs text-fg-muted">{docs(e.documents)}</span>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No intra-EU supplies">No zero-rated sales to other EU states in this period.</EmptyState>
              )}
            </Card>
          ) : null}

          <Card className="mt-6" role="region" aria-label="Cross-border checks">
            <CardHeader title="Cross-border checks" description="Documents whose tax treatment usually needs a second look. Confirm the treatment with your adviser before you file." />
            {d.checks.length ? (
              <Table aria-label="Cross-border checks">
                <thead>
                  <Tr>
                    <Th>Check</Th>
                    <Th>Document</Th>
                    <Th>Contact</Th>
                    <Th>Why</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.checks.map((c) => (
                    <Tr key={c.kind + c.documentId}>
                      <Td className="align-top">
                        <Badge tone={TONE[c.kind]}>{c.label}</Badge>
                      </Td>
                      <Td className="align-top whitespace-nowrap">
                        <Link className="underline" href={docHref(orgId, c.documentKind, c.documentId)}>
                          {KIND_LABEL[c.documentKind]} {c.number}
                        </Link>
                        <span className="block text-xs text-fg-muted">{date(c.issueDate)}</span>
                      </Td>
                      <Td className="align-top">
                        <Link className="underline" href={contactHref(orgId, c.documentKind, c.contactId)}>
                          {c.contactName}
                        </Link>
                      </Td>
                      <Td className="align-top text-sm">{c.message}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing to look at">No cross-border document needs a second look in this period.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
