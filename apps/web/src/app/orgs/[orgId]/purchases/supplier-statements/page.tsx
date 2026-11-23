'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Row {
  id: string;
  contact: { id: string; name: string };
  currency: string;
  from: string;
  to: string;
  status: 'OPEN' | 'RECONCILED';
  theirClosing: string;
  ourClosing: string;
  difference: string;
  statementAddsUp: boolean;
  agrees: boolean;
  lines: number;
}

/** Purchases → Supplier statements (AP-011): statements received from suppliers and how they compare with the books. */
export default function SupplierStatementsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['supplier-statements', orgId], queryFn: () => api<Row[]>(`/v1/orgs/${orgId}/purchases/supplier-statements`) });
  if (!org) return null;
  return (
    <>
      <PageHeader
        title="Supplier statements"
        description="Statements of account your suppliers send, matched to your bills, vendor credits and payments. Every difference between their balance and yours is traced to a line or an item, so you know what to enter, chase or send them."
        actions={can(org.role, 'purchases.manage') ? <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/supplier-statements/new`}>Reconcile a statement</Link> : null}
      />
      <ErrorAlert title="Could not load supplier statements" error={q.error} />
      <Card role="region" aria-label="Statements received">
        <CardHeader title="Statements received" description="Latest first. A statement stays open until it is marked reconciled." />
        {q.data?.length ? (
          <Table aria-label="Statements received">
            <thead><Tr><Th>Supplier</Th><Th>Period</Th><Th numeric>Their balance</Th><Th numeric>Your balance</Th><Th numeric>Difference</Th><Th>Status</Th></Tr></thead>
            <tbody>
              {q.data.map((s) => (
                <Tr key={s.id}>
                  <Td><Link className="underline" href={`/orgs/${orgId}/purchases/supplier-statements/${s.id}`}>{s.contact.name}</Link><span className="block text-xs text-fg-muted">{s.lines} line{s.lines === 1 ? '' : 's'}</span></Td>
                  <Td className="whitespace-nowrap">{date(s.from)} to {date(s.to)}</Td>
                  <Td numeric><Money value={s.theirClosing} currency={s.currency} /></Td>
                  <Td numeric><Money value={s.ourClosing} currency={s.currency} /></Td>
                  <Td numeric className={s.difference === '0.00' ? 'text-fg-muted' : 'font-semibold text-warning'}><Money value={s.difference} currency={s.currency} /></Td>
                  <Td>{s.status === 'RECONCILED' ? <Badge tone="positive">Reconciled</Badge> : !s.statementAddsUp ? <Badge tone="negative">Does not add up</Badge> : s.agrees ? <Badge tone="positive">Agrees</Badge> : <Badge tone="warning">Differences</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? (
          <EmptyState title="No statements yet">When a supplier sends a statement of account, enter it here to check it against your books.</EmptyState>
        ) : null}
      </Card>
    </>
  );
}
