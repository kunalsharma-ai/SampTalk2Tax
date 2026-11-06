import { ORDER_BILLING_LABEL, QUOTE_STATE_LABEL } from '@talk2tax/accounting-engine';
import { Badge } from '@talk2tax/ui';
import type { Order, QuoteState } from '@/lib/sales-orders';

const QUOTE_TONE = { DRAFT: 'neutral', SENT: 'accent', ACCEPTED: 'positive', DECLINED: 'negative', SUPERSEDED: 'neutral', EXPIRED: 'warning' } as const;

export function QuoteBadge({ state }: { state: QuoteState }) {
  return <Badge tone={QUOTE_TONE[state]}>{QUOTE_STATE_LABEL[state]}</Badge>;
}

export function OrderBadge({ order }: { order: Pick<Order, 'status' | 'billing'> }) {
  if (order.status === 'CANCELLED') return <Badge tone="negative">Cancelled</Badge>;
  return <Badge tone={order.billing === 'BILLED' ? 'positive' : order.billing === 'PARTLY_BILLED' ? 'violet' : 'accent'}>{ORDER_BILLING_LABEL[order.billing]}</Badge>;
}
