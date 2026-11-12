import { Injectable } from '@nestjs/common';
import type { CollectionDef } from '@talk2tax/document-db';
import { DocumentStoreService } from '../common/document-store.service';
import { Tx, withSystemAccess } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { mirrorParentDeleted, mirrorRowsWhere, mongoRows, pgOf, POSTGRES_OFF } from './mirror-writes';

/**
 * Writes for a table that has moved to MongoDB while its readers have not (docs/MONGODB.md ›
 * While both databases run). The write goes to MongoDB, inside the caller's PostgreSQL
 * transaction (so both commit together), and the document is then copied into that
 * transaction from what MongoDB now holds. The PostgreSQL row is returned, so callers and
 * readers keep their types until reads move in the last step.
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

  /** Deletes the document and its copy (children go with the copy's cascade). */
  async remove(tx: Tx, table: MovedTable, orgId: string, id: string): Promise<void> {
    await runInOrg(orgId, () => this.store.collection(table.def).deleteOne({ id }));
    if (!POSTGRES_OFF()) await withSystemAccess(tx, () => delegate(tx, table).deleteMany({ where: { id } }));
    await mirrorParentDeleted(tx, this.store, table.def.name, orgId, [id]);
  }

  /** Copies these documents into PostgreSQL inside `tx`, and returns the copies. */
  async copy(tx: Tx, table: MovedTable, ids: string[]): Promise<unknown[]> {
    // With PostgreSQL off there is no copy: the records are returned as MongoDB has them.
    if (POSTGRES_OFF()) {
      const rows = await mongoRows(this.store, table.model, { id: { in: ids } });
      await table.afterWrite?.(tx, rows);
      return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    }
    const docs = await runAsSystem(() => this.store.collection(table.def).find({ id: { $in: ids } }));
    const out: unknown[] = [];
    await withSystemAccess(tx, async () => {
      for (const { id, ...rest } of docs) {
        const kids = table.children;
        const items = kids ? ((rest[kids.field] as { id: string }[] | undefined) ?? []) : [];
        if (kids) delete rest[kids.field];
        const data = table.toRow ? table.toRow(rest) : rest;
        if (!kids) {
          out.push(await write(tx, table, id, data));
          continue;
        }
        // Children (a document's lines) are rewritten only when the set changed: they change only
        // while the parent is a draft, and the copy's triggers refuse touching a posted one's.
        const child = delegate(tx, { model: kids.model } as MovedTable);
        const held = (await child.findMany({ where: { [kids.parentKey]: id }, select: { id: true } })) as { id: string }[];
        const same = held.length === items.length && items.every((c) => held.some((h) => h.id === c.id));
        if (!same && held.length) await child.deleteMany({ where: { [kids.parentKey]: id } });
        const row = await write(tx, table, id, data);
        if (!same && items.length) await child.createMany({ data: items.map((c) => ({ ...(kids.toRow ? kids.toRow(c) : c), [kids.parentKey]: id, orgId: data.orgId })) });
        out.push(row);
      }
    });
    for (const t of table.triggers ?? []) await withSystemAccess(tx, () => mirrorRowsWhere(tx, this.store, t.model, { [t.key]: { in: ids } }));
    return out;
  }
}

export interface MovedTable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: CollectionDef<any>;
  /** The Prisma model that holds the PostgreSQL copy (`contact` for `contacts`). */
  model: string;
  /** Adjusts a document into the copy's columns, when they differ. */
  toRow?: (doc: Record<string, unknown>) => Record<string, unknown>;
  /** An array in the document that PostgreSQL keeps as rows of another table (a document's lines). */
  children?: { field: string; model: string; parentKey: string; toRow?: (item: Record<string, unknown>) => Record<string, unknown> };
  /** Rows a PostgreSQL trigger writes when the copy changes (a new customer's onboarding), kept in step in MongoDB. */
  triggers?: { model: string; key: string }[];
  /** With PostgreSQL off, what those triggers did: run after each write with the records as written. */
  afterWrite?: (tx: Tx, rows: Record<string, unknown>[]) => Promise<void>;
}

/**
 * Update or insert the copy. Not an upsert: PostgreSQL runs BEFORE INSERT triggers for
 * INSERT ... ON CONFLICT even when the row exists, and some refuse a row that is not new.
 */
async function write(tx: Tx, table: Pick<MovedTable, 'model'>, id: string, data: Record<string, unknown>) {
  const d = delegate(tx, table);
  const exists = (await d.findMany({ where: { id }, select: { id: true } })).length > 0;
  return exists ? d.update({ where: { id }, data }) : d.create({ data: { id, ...data } });
}

interface Delegate {
  update(a: unknown): Promise<unknown>;
  create(a: unknown): Promise<unknown>;
  deleteMany(a: unknown): Promise<unknown>;
  findMany(a: unknown): Promise<unknown[]>;
  createMany(a: unknown): Promise<unknown>;
}

/** The PostgreSQL delegate: the copy is compared with what PostgreSQL holds, never with MongoDB. */
function delegate(tx: Tx, table: Pick<MovedTable, 'model'>) {
  return pgOf((tx as unknown as Record<string, Parameters<typeof pgOf>[0]>)[table.model]!) as unknown as Delegate;
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
