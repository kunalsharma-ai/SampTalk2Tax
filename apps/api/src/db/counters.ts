import type { DocumentStore } from '@talk2tax/document-db';
import type { Tx } from '../common/prisma.service';

type Coordination = Pick<DocumentStore, 'nextSequence' | 'nextSerial' | 'raiseSequence' | 'lock' | 'lease' | 'release'>;
let store: Coordination | undefined;

/** The MongoDB store numbering and locks use (none in unit tests without MongoDB). */
export const coordinationStore = (): Coordination | undefined => store;

const required = (): Coordination => {
  if (!store) throw new Error('Numbering and locks need MongoDB: the document store is not set up');
  return store;
};

/** The store of the transaction (its own MongoDB session), or the one set at start-up. */
export function coordinationOf(tx: unknown): Coordination {
  const s = (tx as Record<symbol, unknown> | undefined)?.[Symbol.for('talk2tax.documentStore')] as Coordination | undefined;
  return s ?? required();
}

/** Set once at start-up (prisma.service.ts), so numbering and locks can reach MongoDB from any transaction. */
export function useCounterStore(s: Coordination): void {
  store = s;
}

/**
 * The next number of a per-organisation series (journal entries, documents, orders, ...),
 * inside the caller's transaction so a rollback gives the number back and series stay gap-free.
 * MongoDB holds the number (`_sequences`, `<orgId>:<key>`).
 */
export async function nextCounter(tx: Tx, orgId: string, key: string): Promise<number> {
  return coordinationOf(tx).nextSequence(`${orgId}:${key}`);
}

/** The next number of a platform-wide series (the platform's own tax invoices, per financial year). */
export async function nextPlatformCounter(tx: Tx, series: string): Promise<number> {
  return coordinationOf(tx).nextSequence(`platform:subscription_invoice:${series}`);
}

/**
 * Work one process at a time picks up (an organisation's workflow events, a webhook's feed):
 * runs `fn` while holding a lease on the name, or returns `busy` when another process holds it.
 */
export async function withLease<T>(name: string, seconds: number, busy: T, fn: () => Promise<T>): Promise<T> {
  const s = required();
  if (!(await s.lease(name, seconds))) return busy;
  try {
    return await fn();
  } finally {
    await s.release(name);
  }
}
