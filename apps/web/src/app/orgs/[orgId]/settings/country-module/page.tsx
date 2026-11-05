'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CAPABILITY_LABELS, type CapabilityStatus, type CountryModule, type ModuleLevel, type StarterRate } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface OrgModule {
  countryCode: string;
  module: CountryModule;
  starterRates: (StarterRate & { existing: { id: string; rate: string; isActive: boolean; sameRate: boolean } | null })[];
  taxAccounts: { sales: { code: string; name: string } | null; purchases: { code: string; name: string } | null };
}

const LEVEL: Record<ModuleLevel, { label: string; tone: 'positive' | 'accent' | 'neutral'; text: string }> = {
  FULL: { label: 'Full tax module', tone: 'positive', text: 'The country’s tax engine is built and tested in Talk2Tax.' },
  STARTER: { label: 'Starter module', tone: 'accent', text: 'Accounting works, and standard sales-tax rates can be added to start with. Returns, filings and rule checks are not provided.' },
  ACCOUNTING_ONLY: { label: 'Accounting only', tone: 'neutral', text: 'Accounting works. The country’s sales tax is not modelled; add your own tax rates if you need them.' },
};
const STATUS: Record<CapabilityStatus, { label: string; tone: 'positive' | 'accent' | 'warning' | 'neutral' }> = {
  SUPPORTED: { label: 'Supported', tone: 'positive' },
  PARTLY: { label: 'Partly', tone: 'warning' },
  STARTER: { label: 'Starter', tone: 'accent' },
  NOT_SUPPORTED: { label: 'Not supported', tone: 'neutral' },
};

export default function CountryModulePage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['country-module', orgId], queryFn: () => api<OrgModule>(`/v1/orgs/${orgId}/country-module`), enabled: !!orgId });
  const add = useMutation({
    mutationFn: () => api<{ created: { name: string }[]; skipped: { name: string; reason: string }[] }>(`/v1/orgs/${orgId}/country-module/starter-rates`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['country-module', orgId] }), qc.invalidateQueries({ queryKey: ['tax-rates', orgId] })]);
    },
  });
  if (!org) return null;
  const d = q.data;
  const m = d?.module;
  const missing = (d?.starterRates ?? []).filter((r) => !r.existing);
  const canManage = can(org.role, 'accounts.manage');
  return (
    <>
      <PageHeader
        title="Country module"
        description="What Talk2Tax does for your organisation’s country, what it does not do, and where its rules come from. Nothing here files anything with any authority, and none of it is tax advice."
      />
      <ErrorAlert title="Could not load the country module" error={q.error} />
      {m ? (
        <>
          <Card className="mb-6" aria-label="Module level">
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div>
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                  {m.name} <Badge tone={LEVEL[m.level].tone}>{LEVEL[m.level].label}</Badge>
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-fg-muted">{m.summary}</p>
                <p className="mt-1 max-w-3xl text-sm text-fg-muted">{LEVEL[m.level].text}</p>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                {m.salesTaxName ? (<><dt className="text-fg-muted">Sales tax</dt><dd>{m.salesTaxName}</dd></>) : null}
                {m.taxIdName ? (<><dt className="text-fg-muted">Tax number</dt><dd>{m.taxIdName}</dd></>) : null}
                {m.currency ? (<><dt className="text-fg-muted">Usual currency</dt><dd>{m.currency}</dd></>) : null}
                <dt className="text-fg-muted">Rules last checked</dt>
                <dd>{m.reviewedOn ? date(m.reviewedOn) : 'Never'}</dd>
              </dl>
            </div>
          </Card>

          <Card className="mb-6" aria-label="What is covered">
            <CardHeader title="What is covered" />
            <Table>
              <thead><tr><Th>Area</Th><Th>Status</Th><Th>Details</Th></tr></thead>
              <tbody>
                {m.capabilities.map((c) => (
                  <Tr key={c.key}>
                    <Td className="whitespace-nowrap">{CAPABILITY_LABELS[c.key]}</Td>
                    <Td><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></Td>
                    <Td className="text-fg-muted">{c.note}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {d.starterRates.length ? (
            <Card className="mb-6" aria-label="Starter tax rates">
              <CardHeader
                title={`Starter ${m.salesTaxName ?? 'tax'} rates`}
                description={`The standard national rates, as published by the tax authority when this module was last checked. Confirm them before use: Talk2Tax does not check which rate applies to what you sell or buy. Rates post to ${d.taxAccounts.sales ? `${d.taxAccounts.sales.code} ${d.taxAccounts.sales.name}` : '2300 Output Tax Payable'} and ${d.taxAccounts.purchases ? `${d.taxAccounts.purchases.code} ${d.taxAccounts.purchases.name}` : '1450 Input Tax Receivable'}.`}
              />
              <Table>
                <thead><tr><Th>Name</Th><Th numeric>Rate</Th><Th>About</Th><Th>In your tax rates</Th></tr></thead>
                <tbody>
                  {d.starterRates.map((r) => (
                    <Tr key={r.name}>
                      <Td>{r.name}</Td>
                      <Td numeric className="num">{r.rate}%</Td>
                      <Td className="text-fg-muted">{r.note}</Td>
                      <Td>
                        {!r.existing ? <span className="text-sm text-fg-muted">Not added</span>
                          : r.existing.sameRate ? <Badge tone="positive">{r.existing.isActive ? 'Added' : 'Added, inactive'}</Badge>
                          : <Badge tone="warning">Yours at {r.existing.rate}%</Badge>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
                {add.data ? <span role="status" className="text-sm text-positive">Added {add.data.created.length} {add.data.created.length === 1 ? 'rate' : 'rates'}{add.data.skipped.length ? `; ${add.data.skipped.length} already there` : ''}.</span> : null}
                {canManage ? (
                  <Button disabled={missing.length === 0} loading={add.isPending} onClick={() => add.mutate()}>
                    {missing.length === 0 ? 'All starter rates added' : `Add ${missing.length} starter ${missing.length === 1 ? 'rate' : 'rates'}`}
                  </Button>
                ) : (
                  <span className="text-sm text-fg-muted">Accountants, admins and owners can add these.</span>
                )}
                <Link className="text-sm underline" href={`/orgs/${orgId}/settings/tax-rates`}>Tax rates</Link>
              </div>
              <div className="px-5 pb-4"><ErrorAlert title="Not added" error={add.error} /></div>
            </Card>
          ) : null}

          {m.level === 'FULL' ? (
            <div className="mb-6">
              <Alert tone="accent" title={`${m.salesTaxName} has its own settings`}>
                Set up {m.salesTaxName} under <Link className="underline" href={`/orgs/${orgId}/settings/gst`}>GST settings</Link>, then add rates under <Link className="underline" href={`/orgs/${orgId}/settings/tax-rates`}>Tax rates</Link>.
              </Alert>
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card aria-label="Not covered">
              <CardHeader title="Not covered" description="Do these outside Talk2Tax, with an adviser if you need one." />
              <ul className="list-disc space-y-1 px-9 pb-5 pt-3 text-sm text-fg-muted">
                {m.limitations.map((l) => <li key={l}>{l}</li>)}
              </ul>
            </Card>
            <Card aria-label="Sources">
              <CardHeader title="Sources" description="Where the rules and rates in this module come from." />
              <ul className="space-y-1 px-5 pb-5 pt-3 text-sm">
                {m.sources.length ? m.sources.map((s) => (
                  <li key={s.url}><a className="underline" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a></li>
                )) : <li className="text-fg-muted">No sources: this country has no module yet.</li>}
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
