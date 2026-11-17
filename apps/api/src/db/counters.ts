import type { DocumentStore } from '@talk2tax/document-db';
import type { Tx } from '../common/prisma.service';

type Coordination = Pick<DocumentStore, 'nextSequence' | 'raiseSequence' | 'lock' | 'lease' | 'release'>;
let store: Coordination | undefined;

/** The MongoDB store numbering and locks use (none in unit tests without MongoDB). */
export const coordinationStore = (): Coordination | undefined => store;

/** PostgreSQL takes no writes (T2T_POSTGRES=off): numbering and locks are MongoDB's alone. */
export const postgresOff = () => process.env.T2T_POSTGRES === 'off';

const mongoOnly = (): Coordination => {
  if (!store) throw new Error('With PostgreSQL off, numbering and locks need MongoDB');
  return store;
};

/** The store of the transaction (its own MongoDB session), or the one set at start-up. */
export function coordinationOf(tx: unknown): Coordination {
  const s = (tx as Record<symbol, unknown> | undefined)?.[Symbol.for('talk2tax.documentStore')] as Coordination | undefined;
  return s ?? mongoOnly();
}

/** Set once at start-up (prisma.service.ts), so numbering and locks can reach MongoDB from any transaction. */
export function useCounterStore(s: Coordination): void {
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
  if (postgresOff()) return coordinationOf(tx).nextSequence(`${orgId}:${key}`);
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
  if (postgresOff()) return coordinationOf(tx).nextSequence(`platform:subscription_invoice:${series}`);
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

/**
 * Work one process at a time picks up (an organisation's workflow events, a webhook's feed):
 * runs `fn` while holding a lease on the name, or returns `busy` when another process holds it.
 * Replaces SELECT ... FOR UPDATE SKIP LOCKED and pg_try_advisory_xact_lock once PostgreSQL is off.
 */
export async function withLease<T>(name: string, seconds: number, busy: T, fn: () => Promise<T>): Promise<T> {
  const s = mongoOnly();
  if (!(await s.lease(name, seconds))) return busy;
  try {
    return await fn();
  } finally {
    await s.release(name);
  }
}
