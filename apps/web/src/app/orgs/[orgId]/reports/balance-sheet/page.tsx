'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, Table, Td, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { Money } from '@/components/money';
import { BalancedBadge, DateInput } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Line = { accountId: string; code: string; name: string; amount: string };
interface BS { balanced: boolean; assets: Line[]; liabilities: Line[]; equity: Line[]; unclosedEarnings: string; totalAssets: string; totalLiabilities: string; totalEquity: string }

export default function BalanceSheetPage() {
  const { org, orgId } = useOrg();
  const [asOf, setAsOf] = useState(today());
  const q = useQuery({ queryKey: ['bs', orgId, asOf], queryFn: () => api<BS>(`/v1/orgs/${orgId}/reports/balance-sheet?asOf=${asOf}`) });
  if (!org) return null;
  const c = org.functionalCurrency;
  const rows = (lines: Line[]) => lines.map((l) => <Tr key={l.accountId}><Td><span className="num text-fg-muted">{l.code}</span> {l.name}</Td><Td numeric><Money value={l.amount} currency={c} signed /></Td></Tr>);
  const head = (t: string) => <tr><Td colSpan={2} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{t}</Td></tr>;
  const total = (t: string, v: string) => <tr><Td className="font-semibold">{t}</Td><Td numeric className="font-semibold"><Money value={v} currency={c} signed /></Td></tr>;
  return (
    <>
      <PageHeader title="Balance sheet" description="Assets = liabilities + equity, from posted journals up to the date." actions={<><DateInput label="As of" value={asOf} onChange={setAsOf} />{q.data ? <BalancedBadge balanced={q.data.balanced}>Assets = liabilities + equity</BalancedBadge> : null}</>} />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {q.data ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Assets" />
            <Table><tbody>{rows(q.data.assets)}{total('Total assets', q.data.totalAssets)}</tbody></Table>
          </Card>
          <Card>
            <CardHeader title="Liabilities and equity" />
            <Table>
              <tbody>
                {head('Liabilities')}
                {rows(q.data.liabilities)}
                {total('Total liabilities', q.data.totalLiabilities)}
                {head('Equity')}
                {rows(q.data.equity)}
                <Tr><Td>Earnings not yet closed to retained earnings</Td><Td numeric><Money value={q.data.unclosedEarnings} currency={c} signed /></Td></Tr>
                {total('Total equity', q.data.totalEquity)}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}
    </>
  );
}
