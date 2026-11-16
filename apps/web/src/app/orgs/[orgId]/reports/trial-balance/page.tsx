'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { BalancedBadge, DateInput } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface TB {
  balanced: boolean;
  totals: { debit: string; credit: string; netDebit: string; netCredit: string };
  rows: { accountId: string; code: string; name: string; type: string; netDebit: string; netCredit: string }[];
}

export default function TrialBalancePage() {
  const { org, orgId } = useOrg();
  const [asOf, setAsOf] = useState(today());
  const q = useQuery({ queryKey: ['tb', orgId, asOf], queryFn: () => api<TB>(`/v1/orgs/${orgId}/reports/trial-balance?asOf=${asOf}`) });
  if (!org) return null;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader title="Trial balance" description="Net balance of every account from posted journals." actions={<><DateInput label="As of" value={asOf} onChange={setAsOf} />{q.data ? <BalancedBadge balanced={q.data.balanced} /> : null}<ExportButtons orgId={orgId} report="trial-balance" params={{ asOf }} /></>} />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Account</Th>
              <Th>Type</Th>
              <Th numeric>Debit</Th>
              <Th numeric>Credit</Th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.rows ?? []).map((r) => (
              <Tr key={r.accountId}>
                <Td className="num text-fg-muted">{r.code}</Td>
                <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/reports/general-ledger?accountId=${r.accountId}`}>{r.name}</Link></Td>
                <Td className="text-xs text-fg-muted">{r.type.toLowerCase()}</Td>
                <Td numeric>{r.netDebit !== '0.00' ? <Money value={r.netDebit} currency={c} /> : ''}</Td>
                <Td numeric>{r.netCredit !== '0.00' ? <Money value={r.netCredit} currency={c} /> : ''}</Td>
              </Tr>
            ))}
            {q.data && q.data.rows.length === 0 ? <tr><Td colSpan={5} className="py-8 text-center text-fg-muted">No posted activity up to this date.</Td></tr> : null}
          </tbody>
          {q.data ? (
            <tfoot>
              <tr>
                <Td colSpan={3} className="font-semibold">Total</Td>
                <Td numeric className="font-semibold"><Money value={q.data.totals.netDebit} currency={c} /></Td>
                <Td numeric className="font-semibold"><Money value={q.data.totals.netCredit} currency={c} /></Td>
              </tr>
            </tfoot>
          ) : null}
        </Table>
      </Card>
    </>
  );
}
