'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { SEVERITY_LABEL, SEVERITY_TONE, STATE_LABEL, STATE_TONE, type ContractIssueView, type VendorContract } from '@/components/purchases/vendor-contracts';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Detail extends VendorContract {
  issues: ContractIssueView[];
  prices: { key: string; label: string; hsnCode: string | null; unitPrice: string }[];
  note: string | null;
  terminateReason: string | null;
}

/** One vendor contract with its terms and the bills checked against it (AP-032). */
export default function VendorContractPage() {
  const { org, orgId } = useOrg();
  const { contractId } = useParams<{ contractId: string }>();
  const qc = useQueryClient();
  const key = ['vendor-contract', orgId, contractId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Detail>(`/v1/orgs/${orgId}/purchases/vendor-contracts/${contractId}`) });
  const [reason, setReason] = useState('');
  const [on, setOn] = useState('');
  const end = useMutation({
    mutationFn: () => api<Detail>(`/v1/orgs/${orgId}/purchases/vendor-contracts/${contractId}/terminate`, { method: 'POST', body: { reason, ...(on ? { date: on } : {}) } }),
    onSuccess: (c) => {
      qc.setQueryData(key, c);
      void qc.invalidateQueries({ queryKey: ['vendor-contracts', orgId] });
    },
  });
  if (!org) return null;
  const c = q.data;
  if (q.error) return <ErrorAlert title="Could not load the contract" error={q.error} />;
  if (!c) return null;
  return (
    <>
      <PageHeader title={`${c.reference}: ${c.title}`} description={`${c.vendor.name}${c.vendorReference ? ` · their reference ${c.vendorReference}` : ''} · ${date(c.startDate)} to ${date(c.endDate)}${c.terminatedOn ? `, terminated on ${date(c.terminatedOn)}` : ''}`} actions={<Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>} />
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Billed under the contract" value={<Money value={c.spend} currency={c.currency} />} sub={`${c.billsChecked} ${c.billsChecked === 1 ? 'bill' : 'bills'} checked`} />
        <Stat label="Spend cap" value={c.spendCap ? <Money value={c.spendCap} currency={c.currency} /> : 'None'} tone={c.capUsed && Number.parseFloat(c.capUsed) > 100 /* not money: a percentage */ ? 'negative' : 'neutral'} sub={c.capUsed ? `${c.capUsed}% used` : undefined} />
        <Stat label="Payment terms" value={c.paymentTermsDays === null ? 'Not set' : `${c.paymentTermsDays} days`} sub={c.itemsOnly ? 'Contract items only' : 'Other items allowed'} />
        <Stat label="Billed above contract prices" value={<Money value={c.overcharge} currency={c.currency} />} tone={/[1-9]/.test(c.overcharge) ? 'negative' : 'positive'} sub={`${c.billsWithIssues} ${c.billsWithIssues === 1 ? 'bill' : 'bills'} with findings`} />
      </div>
      <Card className="mb-4">
        <CardHeader title="Findings on bills" description="Each bill from this vendor dated in the contract's term, and bills dated in the year after it ended." />
        {!c.issues.length ? (
          <EmptyState title="No findings">Every bill keeps to this contract.</EmptyState>
        ) : (
          <Table aria-label="Findings on bills">
            <thead><Tr><Th>Bill</Th><Th>Severity</Th><Th>Finding</Th><Th numeric>Amount</Th><Th>Detail</Th></Tr></thead>
            <tbody>
              {c.issues.map((i, n) => (
                <Tr key={`${i.billId}-${i.code}-${n}`}>
                  <Td className="whitespace-nowrap"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${i.billId}`}>{i.billNumber}</Link><div className="text-xs text-fg-muted">{date(i.date)}</div></Td>
                  <Td><Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge></Td>
                  <Td className="whitespace-nowrap">{i.label}</Td>
                  <Td numeric>{i.amount ? <Money value={i.amount} currency={c.currency} /> : '—'}</Td>
                  <Td className="text-sm text-fg-muted">{i.detail}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card className="mb-4">
        <CardHeader title="Contract prices" description="Per unit, before tax." />
        {!c.prices.length ? (
          <EmptyState title="No price list">Only the period, payment terms and cap are checked.</EmptyState>
        ) : (
          <Table aria-label="Contract prices">
            <thead><Tr><Th>Item</Th><Th>HSN/SAC</Th><Th numeric>Unit price</Th></Tr></thead>
            <tbody>
              {c.prices.map((p) => (
                <Tr key={p.key}><Td>{p.label}</Td><Td>{p.hsnCode ?? '—'}</Td><Td numeric><Money value={p.unitPrice} currency={c.currency} /></Td></Tr>
              ))}
            </tbody>
          </Table>
        )}
        {c.note ? <p className="px-4 pb-4 text-sm text-fg-muted">{c.note}</p> : null}
      </Card>
      {c.status === 'TERMINATED' ? (
        <Card>
          <CardHeader title="Terminated" description={`On ${date(c.terminatedOn!)}: ${c.terminateReason}`} />
        </Card>
      ) : can(org.role, 'purchases.manage') ? (
        <Card>
          <CardHeader title="Terminate the contract" description="Bills dated after the termination date count as outside the contract's term. The contract and its terms stay on record." />
          <ErrorAlert title="Could not terminate" error={end.error} />
          <form
            className="flex flex-wrap items-end gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              end.mutate();
            }}
          >
            <Field label="Reason">{(p) => <Input {...p} className="w-72" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />}</Field>
            <Field label="Last day" hint="Today if blank">{(p) => <Input {...p} type="date" className="w-44" value={on} onChange={(e) => setOn(e.target.value)} />}</Field>
            <Button type="submit" variant="secondary" size="sm" disabled={!reason.trim()} loading={end.isPending}>Terminate</Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
