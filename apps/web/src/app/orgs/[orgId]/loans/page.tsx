'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { LoanList } from '@/lib/loans';
import { useOrg } from '@/lib/org';

export default function LoansPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['loans', orgId], queryFn: () => api<LoanList>(`/v1/orgs/${orgId}/loans`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Loans"
        description="Term loans, vehicle loans and other borrowings repaid in monthly installments. Each installment is split into principal and interest from the schedule, and posted from the bank."
        actions={
          <>
            <Link href={`/orgs/${orgId}/treasury`}><Button variant="secondary">Treasury</Button></Link>
            {r?.can.manage ? <Link href={`/orgs/${orgId}/loans/new`}><Button>Add a loan</Button></Link> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load loans" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Owed" value={<Money value={r.totals.balance} currency={cur} />} tone="accent" sub={`${r.totals.active} active ${r.totals.active === 1 ? 'loan' : 'loans'}`} />
            <Stat label="Due within 12 months" value={<Money value={r.totals.current} currency={cur} />} sub="Principal: a current liability" />
            <Stat label="Due after 12 months" value={<Money value={r.totals.nonCurrent} currency={cur} />} tone="violet" sub="Principal: non-current" />
            <Stat label="Overdue installments" value={<Money value={r.totals.overdue} currency={cur} />} tone={+r.totals.overdue === 0 ? 'positive' : 'warning'} sub="Due and not recorded" />
          </div>
          {r.loans.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Loans">
                <thead>
                  <tr>
                    <Th>Loan</Th>
                    <Th numeric>Rate</Th>
                    <Th numeric>Installment</Th>
                    <Th numeric>Owed</Th>
                    <Th>Next installment</Th>
                    <Th>Ends</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.loans.map((l) => (
                    <Tr key={l.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/loans/${l.id}`}>{l.reference} {l.name}</Link>
                        <span className="block text-xs text-fg-faint">{[l.lender, l.method === 'EMI' ? 'EMI' : 'Equal principal', `${l.paid.installments} paid`].filter(Boolean).join(' · ')}</span>
                      </Td>
                      <Td numeric className="num">{l.annualRate}%</Td>
                      <Td numeric><Money value={l.installment} currency={cur} /></Td>
                      <Td numeric className="font-medium"><Money value={l.balance} currency={cur} /></Td>
                      <Td className="whitespace-nowrap text-sm">{l.next ? <>{date(l.next.dueDate)} · <Money value={l.next.payment} currency={cur} /></> : '—'}</Td>
                      <Td className="whitespace-nowrap text-sm">{l.endsOn ? date(l.endsOn) : '—'}</Td>
                      <Td>
                        {l.status === 'CLOSED' ? <Badge>Repaid</Badge> : l.overdue.count ? <Badge tone="warning">{l.overdue.count} overdue</Badge> : <Badge tone="positive">Up to date</Badge>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card><EmptyState title="No loans yet">Add a loan to get its repayment schedule, post installments split into principal and interest, and see what is owed within a year and later.</EmptyState></Card>
          )}
        </>
      ) : null}
    </>
  );
}
