import { Injectable } from '@nestjs/common';
import type { CollectionDef } from '@talk2tax/document-db';
import { DocumentStoreService } from '../common/document-store.service';
import { Tx } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { cascadeDeleted, mongoRows } from './mirror-writes';

/**
 * Writes for a table moved to MongoDB by hand (a collection with its own definition in
 * db/collections). The write runs in the caller's transaction, and the record is returned in its
 * model's shape, so callers keep the model API's types.
 */
@Injectable()
export class MovedTables {
  constructor(private readonly store: DocumentStoreService) {}

  async create<Row>(tx: Tx, table: MovedTable, orgId: string, data: Record<string, unknown>): Promise<Row> {
    const doc = await runInOrg(orgId, () => this.store.collection(table.def).insertOne(forMongo(data) as never));
    return (await this.copy(tx, table, [doc.id as string]))[0] as Row;
  }

  async createMany<Row>(tx: Tx, table: MovedTable, orgId: string, rows: Record<string, unknown>[]): Promise<Row[]> {
    if (!rows.length) return [];
    const docs = await runInOrg(orgId, () => this.store.collection(table.def).insertMany(rows.map((r) => forMongo(r)) as never));
    return (await this.copy(tx, table, docs.map((d) => d.id as string))) as Row[];
  }

  /** Sets these fields on every document the filter matches; returns how many matched. */
  async updateMany(tx: Tx, table: MovedTable, orgId: string, filter: Record<string, unknown>, data: Record<string, unknown>): Promise<number> {
    const ids = (await runInOrg(orgId, () => this.store.collection(table.def).find(filter, { projection: { id: 1 } }))).map((d) => d.id as string);
    if (!ids.length) return 0;
    await runInOrg(orgId, () => this.store.collection(table.def).updateMany({ id: { $in: ids } }, { $set: forMongo(data) }));
    await this.copy(tx, table, ids);
    return ids.length;
  }

  /** Sets these fields (undefined ones are left alone). Returns the row, or null if none matched. */
  async update<Row>(tx: Tx, table: MovedTable, orgId: string, id: string, data: Record<string, unknown>): Promise<Row | null> {
    const set = forMongo(data);
    const r = await runInOrg(orgId, () => this.store.collection(table.def).updateOne({ id }, { $set: set }));
    if (!r.matched) return null;
    return (await this.copy(tx, table, [id]))[0] as Row;
  }

  /** Deletes the document; rows that point at it follow their foreign keys' ON DELETE. */
  async remove(tx: Tx, table: MovedTable, orgId: string, id: string): Promise<void> {
    await runInOrg(orgId, () => this.store.collection(table.def).deleteOne({ id }));
    await cascadeDeleted(tx, this.store, table.def.name, orgId, [id]);
  }

  /** The records as written, in the model's shape, after the table's follow-up work has run. */
  async copy(tx: Tx, table: MovedTable, ids: string[]): Promise<unknown[]> {
    const rows = await mongoRows(this.store, table.model, { id: { in: ids } });
    await table.afterWrite?.(tx, rows);
    return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
  }
}

export interface MovedTable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: CollectionDef<any>;
  /** The model whose shape the records are returned in (`contact` for `contacts`). */
  model: string;
  /** Follow-up work after each write, with the records as written (a new customer's onboarding). */
  afterWrite?: (tx: Tx, rows: Record<string, unknown>[]) => Promise<void>;
}

/** Drops undefined fields and turns decimal objects into the decimal strings MongoDB takes (also inside arrays of objects). */
export function forMongo(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = isDecimal(v) ? v.toFixed() : Array.isArray(v) ? v.map((x) => (isPlain(x) ? forMongo(x) : x)) : v;
  }
  return out;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !isDecimal(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function isDecimal(v: unknown): v is { toFixed(): string } {
  return typeof v === 'object' && v !== null && typeof (v as { toFixed?: unknown }).toFixed === 'function' && typeof (v as { isFinite?: unknown }).isFinite === 'function';
}
