'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { SEVERITY_LABEL, SEVERITY_TONE, STATE_LABEL, STATE_TONE, type ContractIssueView, type VendorContract } from '@/components/purchases/vendor-contracts';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface List {
  asOf: string;
  currency: string;
  summary: { contracts: number; inForce: number; withIssues: number; issues: number; high: number; overcharge: string };
  contracts: (VendorContract & { issues: number })[];
  issues: (ContractIssueView & { contract: { id: string; reference: string }; vendor: { id: string; name: string } })[];
}

/** Vendor contract compliance checks (AP-032). */
export default function VendorContractsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['vendor-contracts', orgId], queryFn: () => api<List>(`/v1/orgs/${orgId}/purchases/vendor-contracts`) });
  if (!org) return null;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Vendor contracts"
        description="Contracts with vendors (period, payment terms, spend cap and price list) and every posted bill checked against the contract covering its date: prices above the contract, items not on it, shorter payment terms, spend over the cap and bills after a contract ended."
        actions={can(org.role, 'purchases.manage') ? <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-contracts/new`}>Record a contract</Link> : null}
      />
      <ErrorAlert title="Could not load vendor contracts" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Contracts" value={d.summary.contracts} sub={`${d.summary.inForce} in force`} />
            <Stat label="Findings" value={d.summary.issues} tone={d.summary.issues ? 'warning' : 'positive'} sub={`${d.summary.withIssues} ${d.summary.withIssues === 1 ? 'contract' : 'contracts'}`} />
            <Stat label="High" value={d.summary.high} tone={d.summary.high ? 'negative' : 'positive'} sub="Overcharged or over the cap" />
            <Stat label="Billed above contract prices" value={<Money value={d.summary.overcharge} currency={d.currency} />} tone={/[1-9]/.test(d.summary.overcharge) ? 'negative' : 'positive'} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Bills breaking a contract" description="Most serious first, then the latest. Ask the vendor for a credit note for amounts billed above the contract." />
            {!d.issues.length ? (
              <EmptyState title="No findings">{d.contracts.length ? 'Every posted bill keeps to its contract.' : 'Record a contract to check bills against it.'}</EmptyState>
            ) : (
              <Table aria-label="Bills breaking a contract">
                <thead><Tr><Th>Severity</Th><Th>Finding</Th><Th>Bill</Th><Th>Vendor</Th><Th>Contract</Th><Th numeric>Amount</Th><Th>Detail</Th></Tr></thead>
                <tbody>
                  {d.issues.map((i, n) => (
                    <Tr key={`${i.billId}-${i.code}-${n}`}>
                      <Td><Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge></Td>
                      <Td className="whitespace-nowrap">{i.label}</Td>
                      <Td className="whitespace-nowrap"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${i.billId}`}>{i.billNumber}</Link><div className="text-xs text-fg-muted">{date(i.date)}</div></Td>
                      <Td>{i.vendor.name}</Td>
                      <Td><Link className="hover:underline" href={`/orgs/${orgId}/purchases/vendor-contracts/${i.contract.id}`}>{i.contract.reference}</Link></Td>
                      <Td numeric>{i.amount ? <Money value={i.amount} currency={d.currency} /> : '—'}</Td>
                      <Td className="max-w-md text-sm text-fg-muted">{i.detail}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Contracts on record" description="Newest first, with what was billed under each." />
            {!d.contracts.length ? (
              <EmptyState title="No contracts yet">Record the terms agreed with a vendor to check their bills.</EmptyState>
            ) : (
              <Table aria-label="Contracts">
                <thead><Tr><Th>Contract</Th><Th>Vendor</Th><Th>Period</Th><Th>State</Th><Th numeric>Billed</Th><Th numeric>Cap used</Th><Th numeric>Findings</Th></Tr></thead>
                <tbody>
                  {d.contracts.map((c) => (
                    <Tr key={c.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-contracts/${c.id}`}>{c.reference}</Link><div className="text-xs text-fg-muted">{c.title}</div></Td>
                      <Td>{c.vendor.name}</Td>
                      <Td className="whitespace-nowrap">{date(c.startDate)} to {date(c.terminatedOn ?? c.endDate)}</Td>
                      <Td><Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge></Td>
                      <Td numeric><Money value={c.spend} currency={d.currency} /></Td>
                      <Td numeric>{c.capUsed === null ? '—' : `${c.capUsed}%`}</Td>
                      <Td numeric>{c.issues}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
