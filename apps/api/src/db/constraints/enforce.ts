import { Prisma } from '@talk2tax/database';
import type { AnyCollectionDef, DocumentStore } from '@talk2tax/document-db';
import { runAsSystem } from '../../common/tenant-context';
import { checksOf, foreignKeys, uniquesOf, type ForeignKey, type UniqueIndex } from './catalog';
import { holds, parseCheck, passes, valueOf } from './sql-expr';

type Row = Record<string, unknown>;
type Store = Pick<DocumentStore, 'collection'>;

/** What the constraints need to know of a table's MongoDB collection. */
export interface TableInfo {
  table: string;
  def: AnyCollectionDef;
  /** Column name to field name. */
  field: (column: string) => string | undefined;
  /** Lines kept inside their parent's document. */
  embedded?: { parent: AnyCollectionDef; path: string };
}

const parsed = new Map<string, { name: string; node: ReturnType<typeof parseCheck> }[]>();

/** As PostgreSQL words it, so callers and tests see the same failure. */
export class CheckViolation extends Error {
  constructor(
    readonly table: string,
    readonly constraint: string,
  ) {
    super(`new row for relation "${table}" violates check constraint "${constraint}"`);
  }
}

/** The record (by column name) passes every CHECK constraint of its table. */
export function enforceChecks(table: string, row: Row) {
  let list = parsed.get(table);
  if (!list) parsed.set(table, (list = checksOf(table).map((c) => ({ name: c.name, node: parseCheck(c.def) }))));
  for (const c of list) if (!passes(c.node, row)) throw new CheckViolation(table, c.name);
}

const referenceError = (fk: ForeignKey, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code: 'P2003', clientVersion: Prisma.prismaVersion.client, meta: { constraint: fk.name, field_name: fk.name } });

let byTable: Map<string, ForeignKey[]> | undefined;
let byReferenced: Map<string, ForeignKey[]> | undefined;
function index() {
  if (!byTable) {
    byTable = new Map();
    byReferenced = new Map();
    for (const fk of foreignKeys()) {
      (byTable.get(fk.table) ?? byTable.set(fk.table, []).get(fk.table)!).push(fk);
      (byReferenced.get(fk.references) ?? byReferenced.set(fk.references, []).get(fk.references)!).push(fk);
    }
  }
  return { byTable: byTable!, byReferenced: byReferenced! };
}

async function exists(store: Store, t: TableInfo, columns: string[], values: unknown[]): Promise<boolean> {
  const fields = columns.map((c) => t.field(c));
  if (fields.some((f) => !f)) return true; // a column MongoDB does not keep: nothing to check against
  const at = (f: string) => (t.embedded ? `${t.embedded.path}.${f}` : f);
  const filter = Object.fromEntries(fields.map((f, i) => [at(f!), values[i]]));
  const coll = store.collection(t.embedded ? t.embedded.parent : t.def);
  return runAsSystem(async () => !!(await coll.findOne(filter, { projection: { _id: 1 } })));
}

/**
 * The record's foreign keys point at records that exist (MATCH SIMPLE: a key with a NULL part is
 * not checked). Deferrable keys are checked by the writes that make them consistent.
 */
export async function enforceReferences(store: Store, child: TableInfo, row: Row, tables: (table: string) => TableInfo | undefined, before?: Row | null) {
  for (const fk of index().byTable.get(child.table) ?? []) {
    if (fk.deferrable) continue;
    const values = fk.columns.map((c) => row[c]);
    if (values.some((v) => v === null || v === undefined)) continue;
    if (before && fk.columns.every((c) => String(before[c]) === String(row[c]))) continue;
    const parent = tables(fk.references);
    if (!parent) continue;
    if (!(await exists(store, parent, fk.referencedColumns, values))) {
      throw referenceError(fk, `insert or update on table "${child.table}" violates foreign key constraint "${fk.name}"`);
    }
  }
}

/**
 * Nothing still points at a deleted record through a key without ON DELETE CASCADE or SET NULL
 * (RESTRICT and NO ACTION). Run after the cascades, as PostgreSQL checks at the statement's end.
 */
export async function enforceNoReferrers(store: Store, parent: TableInfo, row: Row, tables: (table: string) => TableInfo | undefined) {
  for (const fk of index().byReferenced.get(parent.table) ?? []) {
    if (fk.onDelete !== 'RESTRICT' && fk.onDelete !== 'NO ACTION') continue;
    const values = fk.referencedColumns.map((c) => row[c]);
    if (values.some((v) => v === null || v === undefined)) continue;
    const child = tables(fk.table);
    if (!child) continue;
    if (await exists(store, child, fk.columns, values)) {
      throw referenceError(fk, `update or delete on table "${parent.table}" violates foreign key constraint "${fk.name}" on table "${fk.table}"`);
    }
  }
}

const PLAIN = /^[a-z_][a-z0-9_]*$/;
const parsedIndex = new Map<string, { keys: (ReturnType<typeof parseCheck> | string)[]; where: ReturnType<typeof parseCheck> | null }>();
const parsedOf = (u: UniqueIndex) => {
  let p = parsedIndex.get(u.name);
  if (!p) parsedIndex.set(u.name, (p = { keys: u.keys.map((k) => (PLAIN.test(k) ? k : parseCheck(`CHECK (${k})`))), where: u.where ? parseCheck(`CHECK (${u.where})`) : null }));
  return p;
};
const keyText = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * The unique indexes MongoDB cannot hold itself: partial ones (one open dispute per invoice),
 * ones on expressions (codes unique ignoring case), and ones the Prisma schema does not know.
 * For the record (by column name), each index it falls in gives its key, or null for none.
 */
export function uniqueKeys(table: string, row: Row, covered: (columns: string[]) => boolean): { index: UniqueIndex; key: string; plain: Record<string, unknown> }[] {
  const out: { index: UniqueIndex; key: string; plain: Record<string, unknown> }[] = [];
  for (const u of uniquesOf(table)) {
    if (!u.where && u.keys.every((k) => PLAIN.test(k)) && covered(u.keys)) continue;
    const p = parsedOf(u);
    if (p.where && !holds(p.where, row)) continue;
    const values = p.keys.map((k) => (typeof k === 'string' ? row[k] : valueOf(k, row)));
    // NULLs are distinct in a unique index: a key with one never conflicts.
    if (values.some((v) => v === null || v === undefined)) continue;
    const plain = Object.fromEntries(u.keys.filter((k) => PLAIN.test(k)).map((k) => [k, row[k]]));
    out.push({ index: u, key: values.map(keyText).join('|'), plain });
  }
  return out;
}

/** The key the record has in a unique index, or null when it is not in it. */
export function keyIn(u: UniqueIndex, row: Row): string | null {
  const p = parsedOf(u);
  if (p.where && !holds(p.where, row)) return null;
  const values = p.keys.map((k) => (typeof k === 'string' ? row[k] : valueOf(k, row)));
  return values.some((v) => v === null || v === undefined) ? null : values.map(keyText).join('|');
}

/** As PostgreSQL reports a unique index refusing a row, as Prisma's P2002 naming the index. */
export const uniqueViolation = (u: UniqueIndex) =>
  new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the constraint: \`${u.name}\``, { code: 'P2002', clientVersion: Prisma.prismaVersion.client, meta: { target: u.name, modelName: u.table } });
