import { Prisma } from '@talk2tax/database';
import type { Tx } from '../common/prisma.service';
import { coordinationStore } from './counters';

/**
 * Locks one record for the rest of the transaction, so changes to it take turns (posting a
 * document, deciding an approval, closing a period, ...). Returns the locked rows as the SQL
 * `SELECT ... FOR UPDATE` did: none when the record does not exist (or is another
 * organisation's).
 *
 * The lock is held twice while both databases run: PostgreSQL's row lock makes a second
 * transaction wait, and the MongoDB lock document (`_row_locks`, `<table>:<id>`) is what
 * remains when PostgreSQL goes (step 10): a second transaction then conflicts and runs again.
 */
export async function lockRow<T = { id: string }>(tx: Tx, table: string, id: string, orgId?: string): Promise<T[]> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Not a table name: ${table}`);
  const byOrg = orgId === undefined ? Prisma.empty : Prisma.sql` AND org_id = ${orgId}::uuid`;
  const rows = await tx.$queryRaw<T[]>`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid${byOrg} FOR UPDATE`;
  if (rows.length) await coordinationStore()?.lock(`${table}:${id}`);
  return rows;
}

/**
 * A lock on a name rather than a record, for the rest of the transaction: one run per
 * organisation at a time, one writer of an audit chain, and the like. Replaces
 * `pg_advisory_xact_lock(hashtext(name))`, which it still takes while PostgreSQL runs.
 */
export async function lockName(tx: Tx, name: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
  await coordinationStore()?.lock(`name:${name}`);
}

/**
 * Takes only the MongoDB half of a lock, for a caller that still locks its PostgreSQL row with
 * a query of its own (one that also reads the row, or picks it by another column).
 */
export async function holdLock(name: string): Promise<void> {
  await coordinationStore()?.lock(name);
}
