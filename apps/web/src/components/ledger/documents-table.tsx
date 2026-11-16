'use client';
import { Badge, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money } from '@/components/money';
import { date } from '@/lib/format';
import { kindLabel, type LedgerConfig } from '@/lib/ledgers';
import type { DocumentSummary } from '@/lib/types';

export function DocStatus({ d }: { d: Pick<DocumentSummary, 'status' | 'paymentStatus' | 'isOverdue' | 'kind'> }) {
  if (d.status === 'DRAFT') return <Badge tone="warning">Draft</Badge>;
  if (d.status === 'VOID') return <Badge tone="negative">Void</Badge>;
  const isCredit = d.kind === 'CREDIT_NOTE' || d.kind === 'VENDOR_CREDIT';
  if (d.paymentStatus === 'PAID') return <Badge tone="positive">{isCredit ? 'Fully applied' : 'Paid'}</Badge>;
  if (d.isOverdue) return <Badge tone="negative">Overdue</Badge>;
  if (d.paymentStatus === 'PARTIAL') return <Badge tone="violet">{isCredit ? 'Partly applied' : 'Part paid'}</Badge>;
  return <Badge tone="accent">{isCredit ? 'Unapplied' : 'Awaiting payment'}</Badge>;
}

export function DocumentsTable({ l, orgId, items, currency, showContact = true }: { l: LedgerConfig; orgId: string; items: DocumentSummary[]; currency: string; showContact?: boolean }) {
  const router = useRouter();
  return (
    <Table>
      <thead>
        <tr>
          <Th>Number</Th>
          <Th>Type</Th>
          {showContact ? <Th>{l.contact}</Th> : null}
          <Th>Date</Th>
          <Th>Due</Th>
          <Th>Status</Th>
          <Th numeric>Total</Th>
          <Th numeric>Still open</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => {
          const href = `/orgs/${orgId}/${l.docsPath}/${d.id}`;
          return (
            <Tr key={d.id} className="cursor-pointer" onClick={() => router.push(href)}>
              <Td className="num">
                <Link className="text-accent hover:underline" href={href} onClick={(e) => e.stopPropagation()}>{d.number ?? 'Draft'}</Link>
                {d.reference ? <p className="text-xs text-fg-muted">{d.reference}</p> : null}
              </Td>
              <Td className="text-fg-muted">{kindLabel(l, d.kind)}</Td>
              {showContact ? <Td>{d.contact.name}</Td> : null}
              <Td className="whitespace-nowrap">{date(d.issueDate)}</Td>
              <Td className="whitespace-nowrap text-fg-muted">{d.kind === l.charge.kind ? date(d.dueDate) : '—'}</Td>
              <Td><DocStatus d={d} /></Td>
              <Td numeric><Money value={d.total} currency={currency} /></Td>
              <Td numeric>{d.status === 'POSTED' ? <Money value={d.amountDue} currency={currency} /> : <span className="text-fg-faint">—</span>}</Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}
