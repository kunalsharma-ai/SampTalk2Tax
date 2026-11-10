'use client';
import { Badge } from '@talk2tax/ui';
import Link from 'next/link';
import { SEVERITY_LABEL, SEVERITY_TONE, type SupplierIssueRow } from '@/lib/supplier-tax';

/** The issues found for one vendor, with links to the bills they are about. */
export function IssueList({ orgId, issues }: { orgId: string; issues: SupplierIssueRow[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((i) => (
        <li key={i.code} className="flex gap-3 text-sm">
          <Badge tone={SEVERITY_TONE[i.severity]} className="h-fit shrink-0">{SEVERITY_LABEL[i.severity]}</Badge>
          <span>
            {i.message}
            {i.bills?.length ? (
              <span className="block text-xs text-fg-muted">
                {i.bills.slice(0, 8).map((b, n) => (
                  <span key={b.number}>{n ? ', ' : ''}{b.id ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${b.id}`}>{b.number}</Link> : b.number}</span>
                ))}
                {i.bills.length > 8 ? ` and ${i.bills.length - 8} more` : ''}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
