import { createHash } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { validatorFor, type AnyCollectionDef } from './collection';

/**
 * Versioned schema changes. Each migration runs once, in id order, and is recorded in
 * `_migrations` with a checksum of its code: editing a migration after it ran is refused,
 * the same rule Prisma applied to SQL migrations.
 */
export interface Migration {
  /** Sortable and unique, e.g. "20261109090000_foundation". */
  id: string;
  up: (db: Db) => Promise<void>;
}

export function defineMigration(m: Migration): Migration {
  if (!/^\d{14}_[a-z0-9_]+$/.test(m.id)) throw new Error(`Migration id "${m.id}" must look like 20261109090000_name`);
  return m;
}

const LOCK_ID = 'migrations';
const LOCK_TTL_MS = 10 * 60_000;

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(db: Db, migrations: readonly Migration[]): Promise<MigrationReport> {
  const ids = migrations.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error('Two migrations share an id');
  const sorted = [...migrations].sort((a, b) => a.id.localeCompare(b.id));

  await acquireLock(db);
  try {
    const log = db.collection<{ _id: string; checksum: string; appliedAt: Date }>('_migrations');
    const done = new Map((await log.find().toArray()).map((r) => [r._id, r.checksum]));
    const known = new Set(ids);
    for (const id of done.keys()) {
      if (!known.has(id)) throw new Error(`The database has migration ${id}, which this code does not know about`);
    }
    const applied: string[] = [];
    for (const m of sorted) {
      const checksum = checksumOf(m);
      const previous = done.get(m.id);
      if (previous) {
        if (previous !== checksum) throw new Error(`Migration ${m.id} was changed after it was applied`);
        continue;
      }
      await m.up(db);
      await log.insertOne({ _id: m.id, checksum, appliedAt: new Date() });
      applied.push(m.id);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await db.collection('_locks').deleteOne({ _id: LOCK_ID as never });
  }
}

function checksumOf(m: Migration): string {
  return createHash('sha256').update(m.up.toString()).digest('hex');
}

async function acquireLock(db: Db): Promise<void> {
  const locks = db.collection<{ _id: string; until: Date }>('_locks');
  const now = new Date();
  // Take a free or expired lock; a live lock held elsewhere makes this throw on the duplicate key.
  await locks.deleteOne({ _id: LOCK_ID, until: { $lt: now } });
  try {
    await locks.insertOne({ _id: LOCK_ID, until: new Date(now.getTime() + LOCK_TTL_MS) });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new Error('Another process is applying migrations');
    throw e;
  }
}

/**
 * Creates the collection with its validator and indexes, or brings an existing one up to
 * date (collMod + createIndexes). Safe to call again; migrations use it for each collection
 * they introduce or change.
 */
export async function ensureCollection(db: Db, def: AnyCollectionDef): Promise<void> {
  const validator = validatorFor(def);
  const exists = (await db.listCollections({ name: def.name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection(def.name, validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {});
  } else if (validator) {
    await db.command({ collMod: def.name, validator, validationLevel: 'strict', validationAction: 'error' });
  }
  const indexes = [...(def.indexes ?? [])];
  if (def.scope === 'tenant' && !indexes.some((i) => Object.keys(i.key)[0] === 'orgId')) {
    indexes.push({ key: { orgId: 1 }, name: 'org' });
  }
  if (indexes.length) await db.collection(def.name).createIndexes(indexes as never);
}

/** Next value of a named counter (replaces PostgreSQL sequences and autoincrement ids). */
export async function nextSequenceValue(db: Db, name: string, session?: ClientSession): Promise<number> {
  const r = await db
    .collection<{ _id: string; value: number }>('_sequences')
    .findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
  if (!r) throw new Error(`Sequence ${name} did not return a value`);
  return r.value;
}
