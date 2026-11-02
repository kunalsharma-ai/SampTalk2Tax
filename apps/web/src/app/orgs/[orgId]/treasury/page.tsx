'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { shortMonth, type Treasury } from '@/lib/loans';
import { useOrg } from '@/lib/org';

export default function TreasuryPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['treasury', orgId], queryFn: () => api<Treasury>(`/v1/orgs/${orgId}/loans/treasury`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const t = q.data;
  const peak = t ? Math.max(1, ...t.byMonth.map((m) => +m.total)) : 1;
  return (
    <>
      <PageHeader
        title="Treasury"
        description="Cash in the bank against what is borrowed, the installments coming up, and a check that the loan accounts in the ledger agree with the loans. Balances are from posted journals up to today."
        actions={<Link href={`/orgs/${orgId}/loans`}><Button variant="secondary">Loans</Button></Link>}
      />
      <ErrorAlert title="Could not load the treasury position" error={q.error} />
      {t ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Cash and bank" value={<Money value={t.cash.total} currency={cur} />} tone="accent" sub={`${t.cash.accounts.length} accounts on ${date(t.asOf)}`} />
            <Stat label="Borrowings" value={<Money value={t.borrowings.balance} currency={cur} />} tone="violet" sub={<>Within 12 months <Money value={t.borrowings.current} currency={cur} /></>} />
            <Stat label={+t.netCash >= 0 ? 'Net cash' : 'Net debt'} value={<Money value={t.netCash} currency={cur} signed />} tone={+t.netCash >= 0 ? 'positive' : 'negative'} sub="Cash and bank less borrowings" />
            <Stat label="Interest paid this year" value={<Money value={t.interestThisYear.amount} currency={cur} />} sub={`Since ${date(t.interestThisYear.from)}`} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card className="overflow-x-auto">
              <div className="p-4 pb-0"><CardHeader title="Cash and bank" /></div>
              <Table aria-label="Cash and bank balances">
                <thead><tr><Th>Account</Th><Th numeric>Balance</Th></tr></thead>
                <tbody>
                  {t.cash.accounts.map((a) => (
                    <Tr key={a.id}>
                      <Td><span className="num text-fg-muted">{a.code}</span> {a.name} <span className="text-xs text-fg-faint">{a.kind === 'CASH' ? 'Cash' : 'Bank'}</span></Td>
                      <Td numeric><Money value={a.balance} currency={cur} signed /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card className="overflow-x-auto">
              <div className="p-4 pb-0"><CardHeader title="Due in the next 30 days" description="And any installment already due that is not recorded." /></div>
              {t.upcoming.length ? (
                <Table aria-label="Installments due">
                  <thead><tr><Th>Due</Th><Th>Loan</Th><Th numeric>Installment</Th><Th /></tr></thead>
                  <tbody>
                    {t.upcoming.map((u) => (
                      <Tr key={`${u.loanId}-${u.no}`}>
                        <Td className="whitespace-nowrap">{date(u.dueDate)}</Td>
                        <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/loans/${u.loanId}`}>{u.reference} {u.name}</Link> <span className="text-xs text-fg-faint">No. {u.no}</span></Td>
                        <Td numeric><Money value={u.payment} currency={cur} /></Td>
                        <Td>{u.overdue ? <Badge tone="warning">Overdue</Badge> : null}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="Nothing due">No installments fall due in the next 30 days.</EmptyState>
              )}
            </Card>
          </div>
          <Card className="mt-4 overflow-x-auto">
            <div className="p-4 pb-0"><CardHeader title="Repayments over the next 12 months" description="Principal and interest by month from each loan's schedule. Overdue installments are counted in this month." /></div>
            <Table aria-label="Repayments by month">
              <thead><tr><Th>Month</Th><Th numeric>Principal</Th><Th numeric>Interest</Th><Th numeric>Total</Th><Th className="w-1/3" /></tr></thead>
              <tbody>
                {t.byMonth.map((m) => (
                  <Tr key={m.month}>
                    <Td>{shortMonth(m.month)}</Td>
                    <Td numeric><Money value={m.principal} currency={cur} /></Td>
                    <Td numeric><Money value={m.interest} currency={cur} /></Td>
                    <Td numeric className="font-medium"><Money value={m.total} currency={cur} /></Td>
                    <Td>
                      <div className="flex h-2 overflow-hidden rounded bg-surface-raised" aria-hidden>
                        <div className="bg-accent" style={{ width: `${(+m.principal / peak) * 100}%` }} />
                        <div className="bg-violet" style={{ width: `${(+m.interest / peak) * 100}%` }} />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {t.ledger.length ? (
            <Card className="mt-4 overflow-x-auto">
              <div className="p-4 pb-0"><CardHeader title="Loan accounts against the ledger" description="What the ledger says is owed on each loan account, against the loans kept here. A difference means a loan was brought in without posting it (for example from opening balances) or something was posted to the account outside a loan." /></div>
              <Table aria-label="Ledger check">
                <thead><tr><Th>Account</Th><Th numeric>In the ledger</Th><Th numeric>In loans</Th><Th numeric>Difference</Th><Th /></tr></thead>
                <tbody>
                  {t.ledger.map((x) => (
                    <Tr key={x.account.id}>
                      <Td><span className="num text-fg-muted">{x.account.code}</span> {x.account.name}</Td>
                      <Td numeric><Money value={x.ledger} currency={cur} signed /></Td>
                      <Td numeric><Money value={x.loans} currency={cur} /></Td>
                      <Td numeric><Money value={x.difference} currency={cur} signed /></Td>
                      <Td>{+x.difference === 0 ? <Badge tone="positive">Agrees</Badge> : <Badge tone="warning">Check</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
