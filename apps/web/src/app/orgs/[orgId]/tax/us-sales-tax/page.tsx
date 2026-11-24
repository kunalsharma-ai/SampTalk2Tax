'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NEXUS_STATUS_LABEL, type NexusStatus, type UsSalesTaxIssueKind } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useOrg, useTaxRates } from '@/lib/org';
import { can } from '@/lib/types';

type Frequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
interface Overview {
  from: string;
  to: string;
  currency: string;
  checkedOn: string;
  stateList: { code: string; name: string; salesTax: boolean }[];
  registrations: {
    state: string;
    name: string;
    registeredFrom: string;
    permitNumber: string | null;
    filingFrequency: Frequency;
    taxRateId: string | null;
    taxRate: { name: string; rate: string } | null;
  }[];
  nexus: {
    state: string;
    name: string;
    status: NexusStatus;
    salesThreshold: string | null;
    transactionsThreshold: number | null;
    combine: 'OR' | 'AND';
    currentYearSales: string;
    previousYearSales: string;
    transactions: number;
    shareOfThreshold: string | null;
    note: string | null;
  }[];
  nexusYears: { current: number; previous: number };
  customersWithoutState: number;
  states: { state: string; name: string; registered: boolean; gross: string; taxable: string; nonTaxable: string; tax: string; documents: number }[];
  totalTax: string;
  issues: { kind: UsSalesTaxIssueKind; label: string; documentId: string; number: string | null; issueDate: string; contactId: string; contactName: string; message: string }[];
}
const TONE: Record<NexusStatus, 'negative' | 'warning' | 'positive' | 'neutral'> = {
  MUST_REGISTER: 'negative',
  APPROACHING: 'warning',
  REGISTERED: 'positive',
  BELOW: 'neutral',
  NO_SALES_TAX: 'neutral',
};
const FREQ: Record<Frequency, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', ANNUAL: 'Annual' };
const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Tax → US sales tax (TAX-028): state permits, economic nexus by state and the tax charged by state. */
export default function UsSalesTaxPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const rates = useTaxRates();
  const [form, setForm] = useState({ from: '', to: '' });
  const [asked, setAsked] = useState({ from: '', to: '' });
  const [reg, setReg] = useState({ state: '', registeredFrom: today(), permitNumber: '', taxRateId: '', filingFrequency: 'MONTHLY' as Frequency });
  const qs = [asked.from ? `from=${asked.from}` : '', asked.to ? `to=${asked.to}` : ''].filter(Boolean).join('&');
  const key = ['us-sales-tax', orgId, qs];
  const q = useQuery({ queryKey: key, queryFn: () => api<Overview>(`/v1/orgs/${orgId}/tax/us-sales-tax?${qs}`) });
  const save = useMutation({
    mutationFn: () =>
      api<Overview>(`/v1/orgs/${orgId}/tax/us-sales-tax/registrations/${reg.state}`, {
        method: 'PUT',
        body: { registeredFrom: reg.registeredFrom, permitNumber: reg.permitNumber || null, taxRateId: reg.taxRateId || null, filingFrequency: reg.filingFrequency },
      }),
    onSuccess: () => {
      setReg({ ...reg, state: '', permitNumber: '', taxRateId: '' });
      return qc.invalidateQueries({ queryKey: ['us-sales-tax', orgId] });
    },
  });
  const remove = useMutation({
    mutationFn: (state: string) => api<Overview>(`/v1/orgs/${orgId}/tax/us-sales-tax/registrations/${state}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['us-sales-tax', orgId] }),
  });
  if (!org) return null;
  const d = q.data;
  const m = (x: string) => money(x, d?.currency ?? 'USD');
  const manage = can(org.role, 'accounts.manage');
  return (
    <>
      <PageHeader
        title="US sales tax"
        description="The states you hold a sales tax permit in, your sales into every state watched against its economic nexus threshold, and the tax you charged by state for a filing period. Rates are set by states, counties and cities, so Talk2Tax suggests none: add the combined rate you charge in each state as a tax rate and link it to the state. Thresholds need review by a US sales tax adviser."
      />
      <ErrorAlert title="Could not load US sales tax" error={q.error} />
      {d?.customersWithoutState ? (
        <Alert tone="accent" title={`${d.customersWithoutState} customer${d.customersWithoutState === 1 ? ' has' : 's have'} no state`}>
          Sales are counted in the customer&apos;s state. Set the state on each customer (
          <Link className="underline" href={`/orgs/${orgId}/sales/customers`}>
            Customers
          </Link>
          ).
        </Alert>
      ) : null}
      {d ? (
        <>
          <Card className="mt-4" role="region" aria-label="Economic nexus by state">
            <CardHeader
              title="Economic nexus by state"
              description={`Sales into each state before tax, net of credit notes, in ${d.nexusYears.current} and ${d.nexusYears.previous}, against the state's threshold. Thresholds as published, checked on ${date(d.checkedOn)}.`}
            />
            {d.nexus.length ? (
              <Table aria-label="Economic nexus by state">
                <thead>
                  <Tr>
                    <Th>State</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Sales {d.nexusYears.current}</Th>
                    <Th className="text-right">Sales {d.nexusYears.previous}</Th>
                    <Th className="text-right">Invoices</Th>
                    <Th>Threshold</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.nexus.map((n) => (
                    <Tr key={n.state}>
                      <Td>
                        <span className="block">{n.name}</span>
                        <span className="block text-xs text-fg-muted">{n.state}</span>
                      </Td>
                      <Td>
                        <Badge tone={TONE[n.status]}>{NEXUS_STATUS_LABEL[n.status]}</Badge>
                        {n.shareOfThreshold !== null && n.status !== 'REGISTERED' ? <span className="block text-xs text-fg-muted">{n.shareOfThreshold}% of the sales threshold</span> : null}
                      </Td>
                      <Td className="text-right">{m(n.currentYearSales)}</Td>
                      <Td className="text-right">{m(n.previousYearSales)}</Td>
                      <Td className="text-right">{n.transactions}</Td>
                      <Td className="text-sm">
                        {n.salesThreshold
                          ? `${m(n.salesThreshold)}${n.transactionsThreshold ? ` ${n.combine === 'AND' ? 'and' : 'or'} ${n.transactionsThreshold} sales` : ''}`
                          : (n.note ?? 'No statewide sales tax')}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No sales into any state yet">Sales appear here once customers have a state.</EmptyState>
            )}
          </Card>

          <Card className="mt-6" role="region" aria-label="Your state permits">
            <CardHeader title="Your state permits" description="The states you are registered to collect sales tax in, with the rate you charge there and how often you file." />
            {d.registrations.length ? (
              <Table aria-label="Your state permits">
                <thead>
                  <Tr>
                    <Th>State</Th>
                    <Th>Permit</Th>
                    <Th>Since</Th>
                    <Th>Rate charged</Th>
                    <Th>Filing</Th>
                    {manage ? (
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    ) : null}
                  </Tr>
                </thead>
                <tbody>
                  {d.registrations.map((r) => (
                    <Tr key={r.state}>
                      <Td>{r.name}</Td>
                      <Td>{r.permitNumber ?? '—'}</Td>
                      <Td>{date(r.registeredFrom)}</Td>
                      <Td>{r.taxRate ? `${r.taxRate.name} (${r.taxRate.rate}%)` : 'Not linked'}</Td>
                      <Td>{FREQ[r.filingFrequency]}</Td>
                      {manage ? (
                        <Td className="text-right">
                          <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === r.state} onClick={() => remove.mutate(r.state)}>
                            Remove {r.name}
                          </Button>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No permits recorded">Add each state you hold a sales tax permit in.</EmptyState>
            )}
            {manage ? (
              <form
                className="flex flex-wrap items-end gap-3 border-t border-line p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reg.state) save.mutate();
                }}
              >
                <Field label="State">
                  {(p) => (
                    <Select {...p} value={reg.state} onChange={(e) => setReg({ ...reg, state: e.target.value })}>
                      <option value="">Choose…</option>
                      {d.stateList
                        .filter((s) => s.salesTax)
                        .map((s) => (
                          <option key={s.code} value={s.code}>
                            {s.name}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
                <Field label="Permit number">{(p) => <Input {...p} maxLength={50} value={reg.permitNumber} onChange={(e) => setReg({ ...reg, permitNumber: e.target.value })} />}</Field>
                <Field label="Registered from">{(p) => <Input {...p} type="date" value={reg.registeredFrom} onChange={(e) => setReg({ ...reg, registeredFrom: e.target.value })} />}</Field>
                <Field label="Rate charged">
                  {(p) => (
                    <Select {...p} value={reg.taxRateId} onChange={(e) => setReg({ ...reg, taxRateId: e.target.value })}>
                      <option value="">Not linked</option>
                      {(rates.data ?? []).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({r.rate}%)
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Filing">
                  {(p) => (
                    <Select {...p} value={reg.filingFrequency} onChange={(e) => setReg({ ...reg, filingFrequency: e.target.value as Frequency })}>
                      {(Object.keys(FREQ) as Frequency[]).map((f) => (
                        <option key={f} value={f}>
                          {FREQ[f]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button type="submit" disabled={!reg.state} loading={save.isPending}>
                  Save permit
                </Button>
              </form>
            ) : null}
            <div className="px-4 pb-4">
              <ErrorAlert title="Could not save the permit" error={save.error ?? remove.error} />
            </div>
          </Card>

          <Card className="mt-6" role="region" aria-label="Sales tax by state">
            <CardHeader title="Sales tax by state" description={`${date(d.from)} to ${date(d.to)}: the figures for each state's return. Total tax charged ${m(d.totalTax)}.`} />
            <form
              className="flex flex-wrap items-end gap-3 px-4 pb-4"
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
            {d.states.length ? (
              <Table aria-label="Sales tax by state">
                <thead>
                  <Tr>
                    <Th>State</Th>
                    <Th className="text-right">Gross sales</Th>
                    <Th className="text-right">Taxable</Th>
                    <Th className="text-right">Not taxed</Th>
                    <Th className="text-right">Tax charged</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.states.map((s) => (
                    <Tr key={s.state}>
                      <Td>
                        <span className="block">{s.name}</span>
                        <span className="block text-xs text-fg-muted">
                          {s.registered ? 'Registered, ' : ''}
                          {docs(s.documents)}
                        </span>
                      </Td>
                      <Td className="text-right">{m(s.gross)}</Td>
                      <Td className="text-right">{m(s.taxable)}</Td>
                      <Td className="text-right">{m(s.nonTaxable)}</Td>
                      <Td className="text-right">{m(s.tax)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No sales in this period">Choose another period.</EmptyState>
            )}
          </Card>

          <Card className="mt-6" role="region" aria-label="Sales tax to check">
            <CardHeader
              title="Sales tax to check"
              description="Sales in the period whose tax looks wrong for the state. Exempt sales (resale or exemption certificates) are not recorded yet, so check those against your certificates."
            />
            {d.issues.length ? (
              <Table aria-label="Sales tax to check">
                <thead>
                  <Tr>
                    <Th>Check</Th>
                    <Th>Invoice</Th>
                    <Th>Customer</Th>
                    <Th>Why</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.issues.map((i) => (
                    <Tr key={i.kind + i.documentId}>
                      <Td className="align-top">
                        <Badge tone="warning">{i.label}</Badge>
                      </Td>
                      <Td className="align-top whitespace-nowrap">
                        <Link className="underline" href={`/orgs/${orgId}/sales/invoices/${i.documentId}`}>
                          {i.number}
                        </Link>
                        <span className="block text-xs text-fg-muted">{date(i.issueDate)}</span>
                      </Td>
                      <Td className="align-top">
                        <Link className="underline" href={`/orgs/${orgId}/sales/customers/${i.contactId}`}>
                          {i.contactName}
                        </Link>
                      </Td>
                      <Td className="align-top text-sm">{i.message}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing to check">No sale in this period looks wrong for its state.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
