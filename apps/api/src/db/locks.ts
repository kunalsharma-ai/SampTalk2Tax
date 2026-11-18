import type { Tx } from '../common/prisma.service';
import { coordinationOf } from './counters';

/**
 * Locks one record for the rest of the transaction, so changes to it take turns (posting a
 * document, deciding an approval, closing a period, ...). Returns the locked rows as
 * `SELECT ... FOR UPDATE` did: none when the record does not exist (or is another
 * organisation's). The lock is a MongoDB lock document (`_row_locks`, `<table>:<id>`): a second
 * transaction that takes it conflicts and runs again.
 */
export async function lockRow<T = { id: string }>(tx: Tx, table: string, id: string, orgId?: string): Promise<T[]> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Not a table name: ${table}`);
  const { tableHolder } = await import('./mirror-writes');
  if (!(await tableHolder(tx, table, id, orgId))) return [];
  await coordinationOf(tx).lock(`${table}:${id}`);
  return [{ id } as T];
}

/**
 * A lock on a name rather than a record, for the rest of the transaction: one run per
 * organisation at a time, one writer of an audit chain, and the like.
 */
export async function lockName(tx: Tx, name: string): Promise<void> {
  await coordinationOf(tx).lock(`name:${name}`);
}

/** A lock document by its own name (`period_closes:period:<id>`), for a record picked by another column. */
export async function holdLock(name: string): Promise<void> {
  await coordinationOf(undefined).lock(name);
}
