import type { DocumentStore } from '@talk2tax/document-db';
import type { Tx } from '../common/prisma.service';

let store: Pick<DocumentStore, 'nextSequence' | 'raiseSequence'> | undefined;

/** Set once at start-up (prisma.service.ts), so numbering can reach MongoDB from any transaction. */
export function useCounterStore(s: Pick<DocumentStore, 'nextSequence' | 'raiseSequence'>): void {
  store = s;
}

/**
 * The next number of a per-organisation series (journal entries, documents, orders, ...),
 * inside the caller's transaction so a rollback gives the number back and series stay gap-free.
 *
 * MongoDB holds the number (`_sequences`, `<orgId>:<key>`). While both databases run, the
 * PostgreSQL org_counters row is still bumped first: its row lock makes concurrent postings wait
 * their turn rather than fail on a MongoDB write conflict, and an installation whose MongoDB
 * counter was never copied catches up to it here. Step 10 drops the PostgreSQL half.
 */
export async function nextCounter(tx: Tx, orgId: string, key: string): Promise<number> {
  const [{ value: held }] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO org_counters (org_id, key, value) VALUES (${orgId}::uuid, ${key}, 1)
    ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
    RETURNING value`;
  if (!store) return held;
  const name = `${orgId}:${key}`;
  const value = await store.nextSequence(name);
  if (value >= held) return value;
  await store.raiseSequence(name, held);
  return held;
}

/** The next number of a platform-wide series (the platform's own tax invoices, per financial year). */
export async function nextPlatformCounter(tx: Tx, series: string): Promise<number> {
  const [{ last: held }] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO subscription_invoice_counters (series, last) VALUES (${series}, 1)
    ON CONFLICT (series) DO UPDATE SET last = subscription_invoice_counters.last + 1
    RETURNING last`;
  if (!store) return held;
  const name = `platform:subscription_invoice:${series}`;
  const value = await store.nextSequence(name);
  if (value >= held) return value;
  await store.raiseSequence(name, held);
  return held;
}
