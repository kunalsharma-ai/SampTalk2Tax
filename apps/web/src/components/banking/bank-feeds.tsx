'use client';
import { Badge, Button } from '@talk2tax/ui';
import { useState } from 'react';

export type FeedHealth = 'HEALTHY' | 'LATE' | 'FAILING' | 'WAITING' | 'PAUSED' | 'REVOKED';
export type FeedOutcome = 'IMPORTED' | 'NOTHING_NEW' | 'REJECTED' | 'FAILED';
export interface BankFeed {
  id: string;
  name: string;
  kind: 'TRANSACTIONS' | 'STATEMENT_FILE';
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  health: FeedHealth;
  healthMessage: string;
  account: { id: string; code: string; name: string; currency: string };
  prefix: string;
  expectEveryHours: number;
  createdBy: string | null;
  createdAt: string;
  tokenIssuedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  lastDeliveryAt: string | null;
  lastOutcome: FeedOutcome | null;
  lastAcceptedAt: string | null;
  deliveryCount: number;
  linesImported: number;
  /** Only right after it is set up or its token is replaced. */
  token?: string;
}
export interface BankFeedDelivery {
  id: string;
  receivedAt: string;
  outcome: FeedOutcome;
  fileName: string | null;
  received: number;
  imported: number;
  duplicates: number;
  rejected: number;
  rejections: { position: number; id: string | null; reasons: string[] }[];
  importId: string | null;
  error: string | null;
}

export const FEED_KIND = { TRANSACTIONS: 'Transactions (JSON)', STATEMENT_FILE: 'Statement files (OFX, QIF, MT940)' } as const;
export const EXPECT_HOURS = [1, 6, 24, 72, 168] as const;
export const every = (h: number) => (h === 1 ? 'every hour' : h === 168 ? 'every week' : h % 24 === 0 ? `every ${h / 24 === 1 ? 'day' : `${h / 24} days`}` : `every ${h} hours`);

const HEALTH: Record<FeedHealth, { label: string; tone: 'positive' | 'warning' | 'negative' | 'neutral' }> = {
  HEALTHY: { label: 'Healthy', tone: 'positive' },
  LATE: { label: 'Late', tone: 'warning' },
  FAILING: { label: 'Failing', tone: 'negative' },
  WAITING: { label: 'Waiting', tone: 'neutral' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  REVOKED: { label: 'Disconnected', tone: 'neutral' },
};
export function HealthBadge({ health }: { health: FeedHealth }) {
  return <Badge tone={HEALTH[health].tone}>{HEALTH[health].label}</Badge>;
}

const OUTCOME: Record<FeedOutcome, { label: string; tone: 'positive' | 'neutral' | 'negative' }> = {
  IMPORTED: { label: 'Added', tone: 'positive' },
  NOTHING_NEW: { label: 'Nothing new', tone: 'neutral' },
  REJECTED: { label: 'Refused', tone: 'negative' },
  FAILED: { label: 'Unreadable', tone: 'negative' },
};
export function OutcomeBadge({ outcome }: { outcome: FeedOutcome }) {
  return <Badge tone={OUTCOME[outcome].tone}>{OUTCOME[outcome].label}</Badge>;
}

/** The secret, shown once, with how the sender uses it. */
export function FeedToken({ feed }: { feed: BankFeed & { token: string } }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <div className="space-y-3 text-sm">
      <p>Give this token to whoever sends the feed. It is shown only now; if it is lost, replace it.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-surface-raised px-2 py-1 font-mono text-xs" aria-label="Feed token">{feed.token}</code>
        <Button type="button" size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(feed.token).then(() => setCopied(true)).catch(() => undefined)}>{copied ? 'Copied' : 'Copy token'}</Button>
      </div>
      <SenderInstructions kind={feed.kind} origin={origin} />
    </div>
  );
}

export function SenderInstructions({ kind, origin }: { kind: BankFeed['kind']; origin: string }) {
  const code = 'font-mono text-xs';
  return kind === 'TRANSACTIONS' ? (
    <p className="text-fg-muted">
      Send <code className={code}>POST {origin}/api/bank-feed/transactions</code> with <code className={code}>Authorization: Bearer t2tf_…</code> and a JSON body{' '}
      <code className={code}>{'{"transactions":[{"id":"UTR123","date":"2026-11-20","amount":"-2500.00","description":"Power bill","reference":"UTR123"}]}'}</code>. Amounts are strings; negative is money out (or send an unsigned amount with <code className={code}>direction</code> CREDIT or DEBIT). Up to 1,000 at a time. The id is yours: sending the same id again never adds it twice. <code className={code}>GET /api/bank-feed/me</code> checks the token.
    </p>
  ) : (
    <p className="text-fg-muted">
      Send <code className={code}>POST {origin}/api/bank-feed/statement</code> with <code className={code}>Authorization: Bearer t2tf_…</code> and a JSON body <code className={code}>{'{"fileName":"stmt.sta","content":"…"}'}</code> holding an OFX, QIF or MT940 file under 2 MB. Lines already on the account, from this feed or an uploaded file, are skipped. <code className={code}>GET /api/bank-feed/me</code> checks the token.
    </p>
  );
}
