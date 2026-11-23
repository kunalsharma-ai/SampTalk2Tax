'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { type Dependencies, DependencyGraph, type DependencyGroup, GROUP, type GraphPick, SEVERITY } from '@/components/reports/dependency-graph';
import { monthLabel } from '@/components/reports/financial-visuals';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { graphHref } from '@/lib/graph';
import { useOrg } from '@/lib/org';

const GROUPS: DependencyGroup[] = ['CUSTOMERS', 'VENDORS', 'CASH', 'BORROWING'];
const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const DESC: Record<DependencyGroup, string> = {
  CUSTOMERS: 'Revenue before tax by customer over the months chosen, from posted invoices less credit notes.',
  VENDORS: 'Spending before tax by vendor over the months chosen, from posted bills less vendor credits.',
  CASH: 'Cash held in each cash and bank account at the end of the months chosen.',
  BORROWING: 'What is owed on each loan, long-term debt and card account at the end of the months chosen.',
};
const CONCENTRATION = { LOW: { label: 'Spread out', tone: 'positive' }, MODERATE: { label: 'Moderately concentrated', tone: 'warning' }, HIGH: { label: 'Highly concentrated', tone: 'negative' } } as const;

/**
 * Reports → Financial dependencies (DASH-037): who the business depends on for its money, drawn
 * as a network: revenue by customer and spending by vendor over the months chosen, and cash by
 * account and borrowing at their end, with how concentrated each group is and the single
 * dependencies worth watching. Choose a party to see its details and open its records.
 */
export default function FinancialDependenciesPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => shift(today().slice(0, 7), -11));
  const [shown, setShown] = useState<DependencyGroup[]>(GROUPS);
  const [picked, setPicked] = useState<GraphPick | null>(null);
  const q = useQuery({ queryKey: ['dependencies', orgId, from, to], queryFn: () => api<Dependencies>(`/v1/orgs/${orgId}/reports/dependencies?from=${from}&to=${to}`), enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) });
  if (!org) return null;
  const d = q.data;
  const c = d?.currency ?? org.functionalCurrency;
  const toggle = (g: DependencyGroup) => { setShown((s) => (s.includes(g) ? s.filter((x) => x !== g) : GROUPS.filter((x) => s.includes(x) || x === g))); setPicked(null); };
  const dep = picked && d ? d.dependencies.find((x) => x.group === picked.group && x.id === picked.id) : null;
  const isContact = (g: DependencyGroup) => g === 'CUSTOMERS' || g === 'VENDORS';
  const record = (p: GraphPick) => (p.others ? null : p.group === 'CUSTOMERS' ? `/orgs/${orgId}/sales/customers/${p.id}` : p.group === 'VENDORS' ? `/orgs/${orgId}/purchases/vendors/${p.id}` : `/orgs/${orgId}/reports/general-ledger?accountId=${p.id}&from=${d?.fromDate}&to=${d?.toDate}`);
  const empty = d ? GROUPS.every((g) => d.groups[g].count === 0) : false;
  return (
    <>
      <PageHeader
        title="Financial dependencies"
        description="Who the business depends on for its money: customers for revenue and vendors for spending over the months you choose, and the accounts holding its cash and the lenders it owes at their end. Wider lines are larger shares; red and orange mark dependencies worth watching. Choose any party to see it and open its records."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From month">{(p) => <Input {...p} type="month" value={from} onChange={(e) => { setFrom(e.target.value); setPicked(null); }} />}</Field>
        <Field label="To month">{(p) => <Input {...p} type="month" value={to} onChange={(e) => { setTo(e.target.value); setPicked(null); }} />}</Field>
        <fieldset className="flex flex-wrap items-center gap-3 pb-2 text-sm">
          <legend className="sr-only">Groups to show</legend>
          {GROUPS.map((g) => (
            <label key={g} className="flex items-center gap-1.5"><input type="checkbox" checked={shown.includes(g)} onChange={() => toggle(g)} /><span style={{ color: GROUP[g].colour }}>●</span> {GROUP[g].label}</label>
          ))}
        </fieldset>
      </div>
      <ErrorAlert title="Could not work out the dependencies" error={q.error} />
      {d ? (
        <div className="grid gap-4">
          <Card role="region" aria-label="Dependency network">
            <CardHeader title="Dependency network" description={`Revenue and spending ${monthLabel(d.from)} to ${monthLabel(d.to)}; cash and borrowing on ${date(d.toDate)}. The largest six of each group are drawn, the rest joined as others.`} />
            {empty ? <p className="px-5 pb-5 text-sm text-fg-muted">Nothing posted to depend on yet. Post invoices, bills and bank entries, or choose other months.</p> : (
              <div className="grid gap-4 px-4 pb-4 lg:grid-cols-[1fr_300px]">
                <DependencyGraph d={d} shown={shown} picked={picked} onPick={setPicked} />
                <aside className="rounded-md border border-line p-4 text-sm" aria-label="Chosen party" aria-live="polite">
                  {picked ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-fg-muted">{GROUP[picked.group].flow}</p>
                      <h2 className="text-base font-semibold">{picked.name}</h2>
                      <p className="num text-lg"><Money value={picked.amount} currency={c} /></p>
                      <p className="text-fg-muted">{picked.share}% of {GROUP[picked.group].label.toLowerCase()}</p>
                      {dep ? <p><Badge tone={SEVERITY[dep.severity].tone}>{SEVERITY[dep.severity].label}</Badge> <span className="ml-1">{dep.reason}</span></p> : picked.others ? <p className="text-fg-muted">The smaller parties together.</p> : <p className="text-fg-muted">Not a dependency to watch.</p>}
                      {record(picked) ? <Link className="text-accent hover:underline" href={record(picked)!}>{isContact(picked.group) ? `Open ${picked.group === 'CUSTOMERS' ? 'customer' : 'vendor'}` : 'Open the ledger'}</Link> : null}
                      {!picked.others ? <Link className="text-accent hover:underline" href={graphHref(orgId, { type: isContact(picked.group) ? 'CONTACT' : 'ACCOUNT', id: picked.id })}>Explore connections</Link> : null}
                      <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>Clear the choice</Button>
                    </div>
                  ) : <p className="text-fg-muted">Choose a customer, vendor, account or lender in the network to see its share and open its records.</p>}
                </aside>
              </div>
            )}
          </Card>

          <Card role="region" aria-label="Dependencies to watch">
            <CardHeader title="Dependencies to watch" description="A single customer from 15% of revenue, a vendor from 20% of spending, one cash account from 75% of cash (when there are several), one lender from half the borrowing, or borrowing above the cash held." />
            {d.dependencies.length ? (
              <ul className="flex flex-col gap-2 px-5 pb-4 text-sm" aria-label="Dependencies">
                {d.dependencies.map((x) => (
                  <li key={`${x.group}:${x.id}`} className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY[x.severity].tone}>{SEVERITY[x.severity].label}</Badge>
                    {x.id === 'ALL' ? <span>{x.reason}</span> : <button type="button" className="text-left hover:text-accent" onClick={() => { const g = d.groups[x.group].parties.find((p) => p.id === x.id); if (g) { setShown((s) => (s.includes(x.group) ? s : [...s, x.group])); setPicked({ group: x.group, ...g }); } }}>{x.reason}</button>}
                    <span className="num text-fg-muted"><Money value={x.amount} currency={c} /></span>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 pb-4 text-sm text-fg-muted">No single party carries a share worth watching.</p>}
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            {GROUPS.map((g) => {
              const v = d.groups[g];
              return (
                <Card key={g} role="region" aria-label={GROUP[g].label}>
                  <CardHeader title={`${GROUP[g].label} by share`} description={`${DESC[g]} ${v.count} in all.`} />
                  <div className="flex flex-wrap items-center gap-3 px-5 pb-2 text-sm">
                    <span>Total <Money value={v.total} currency={c} /></span>
                    {v.concentration ? <Badge tone={CONCENTRATION[v.concentration].tone}>{CONCENTRATION[v.concentration].label}</Badge> : null}
                    {v.concentration ? <span className="text-xs text-fg-muted">Concentration index {v.hhi.toLocaleString('en-IN')} of 10,000</span> : null}
                  </div>
                  {v.count ? (
                    <Table aria-label={`${GROUP[g].label} by share`}>
                      <thead><Tr><Th>{g === 'CUSTOMERS' ? 'Customer' : g === 'VENDORS' ? 'Vendor' : 'Account'}</Th><Th numeric>Amount</Th><Th numeric>Share</Th></Tr></thead>
                      <tbody>
                        {v.parties.map((p) => (
                          <Tr key={p.id}>
                            <Td><button type="button" className="text-left hover:text-accent" onClick={() => { setShown((s) => (s.includes(g) ? s : [...s, g])); setPicked({ group: g, ...p }); }}>{p.name}</button></Td>
                            <Td numeric><Money value={p.amount} currency={c} /></Td>
                            <Td numeric>{p.share}%</Td>
                          </Tr>
                        ))}
                        {v.others.count ? <Tr><Td className="text-fg-muted">{v.others.count} other{v.others.count === 1 ? '' : 's'}</Td><Td numeric><Money value={v.others.amount} currency={c} /></Td><Td numeric>{v.others.share}%</Td></Tr> : null}
                      </tbody>
                    </Table>
                  ) : <p className="px-5 pb-4 text-sm text-fg-muted">None.</p>}
                </Card>
              );
            })}
          </div>
        </div>
      ) : !q.error ? <p className="text-sm text-fg-muted">Working out the dependencies…</p> : null}
    </>
  );
}
