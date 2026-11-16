import { PURCHASE_ORDER_STATE_LABEL, type PurchaseOrderState } from '@talk2tax/accounting-engine';
import { Badge } from '@talk2tax/ui';
import type { BillMatchStatus } from '@/lib/purchase-orders';

const TONE = { DRAFT: 'neutral', ISSUED: 'accent', PARTLY_RECEIVED: 'violet', RECEIVED: 'warning', BILLED: 'positive', CLOSED: 'neutral', CANCELLED: 'negative' } as const;

export function PurchaseOrderBadge({ state }: { state: PurchaseOrderState }) {
  return <Badge tone={TONE[state]}>{PURCHASE_ORDER_STATE_LABEL[state]}</Badge>;
}

const MATCH = { MATCHED: ['positive', 'Matches the order'], ACCEPTED: ['warning', 'Differences accepted'], EXCEPTION: ['negative', 'Does not match'] } as const;

export function MatchBadge({ status }: { status: BillMatchStatus }) {
  return <Badge tone={MATCH[status][0]}>{MATCH[status][1]}</Badge>;
}
