import { Injectable } from '@nestjs/common';
import type { CollectionDef } from '@talk2tax/document-db';
import { DocumentStoreService } from '../common/document-store.service';
import { Tx, withSystemAccess } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';

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

  /** Sets these fields (undefined ones are left alone). Returns the row, or null if none matched. */
  async update<Row>(tx: Tx, table: MovedTable, orgId: string, id: string, data: Record<string, unknown>): Promise<Row | null> {
    const set = forMongo(data);
    const r = await runInOrg(orgId, () => this.store.collection(table.def).updateOne({ id }, { $set: set }));
    if (!r.matched) return null;
    return (await this.copy(tx, table, [id]))[0] as Row;
  }

  async remove(tx: Tx, table: MovedTable, orgId: string, id: string): Promise<void> {
    await runInOrg(orgId, () => this.store.collection(table.def).deleteOne({ id }));
    await withSystemAccess(tx, () => delegate(tx, table).deleteMany({ where: { id } }));
  }

  /** Copies these documents into PostgreSQL inside `tx`, and returns the copies. */
  async copy(tx: Tx, table: MovedTable, ids: string[]): Promise<unknown[]> {
    const docs = await runAsSystem(() => this.store.collection(table.def).find({ id: { $in: ids } }));
    const out: unknown[] = [];
    await withSystemAccess(tx, async () => {
      for (const { id, ...rest } of docs) {
        const data = table.toRow ? table.toRow(rest) : rest;
        out.push(await delegate(tx, table).upsert({ where: { id }, create: { id, ...data }, update: data }));
      }
    });
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
}

function delegate(tx: Tx, table: MovedTable) {
  return (tx as unknown as Record<string, { upsert: (a: unknown) => Promise<unknown>; deleteMany: (a: unknown) => Promise<unknown> }>)[table.model]!;
}

/** Drops undefined fields and turns decimal objects into the decimal strings MongoDB takes. */
export function forMongo(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = isDecimal(v) ? v.toFixed() : v;
  }
  return out;
}

function isDecimal(v: unknown): v is { toFixed(): string } {
  return typeof v === 'object' && v !== null && typeof (v as { toFixed?: unknown }).toFixed === 'function' && typeof (v as { isFinite?: unknown }).isFinite === 'function';
}
