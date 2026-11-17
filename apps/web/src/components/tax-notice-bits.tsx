'use client';
import { Badge } from '@talk2tax/ui';
import type { TaxNoticeSummary } from '@/lib/tax-notices';

/** Where a notice stands: overdue, due soon, upcoming, no deadline, or replied / closed. */
export function NoticeUrgency({ n }: { n: Pick<TaxNoticeSummary, 'status' | 'urgency' | 'daysLeft' | 'outcomeLabel'> }) {
  if (n.status === 'CLOSED') return <Badge>Closed{n.outcomeLabel ? ` · ${n.outcomeLabel}` : ''}</Badge>;
  if (n.status === 'RESPONDED') return <Badge tone="accent">Replied</Badge>;
  if (n.urgency === 'OVERDUE') return <Badge tone="negative">Overdue by {-(n.daysLeft ?? 0)} {n.daysLeft === -1 ? 'day' : 'days'}</Badge>;
  if (n.urgency === 'DUE_SOON') return <Badge tone="warning">{n.daysLeft === 0 ? 'Due today' : `Due in ${n.daysLeft} ${n.daysLeft === 1 ? 'day' : 'days'}`}</Badge>;
  if (n.urgency === 'UPCOMING') return <Badge tone="positive">Due in {n.daysLeft} days</Badge>;
  return <Badge>No deadline</Badge>;
}
