import { Prisma } from '@talk2tax/database';
import { defineCollection, type AnyCollectionDef } from '@talk2tax/document-db';
type Document = Record<string, unknown>;
import type { DocumentStore } from '@talk2tax/document-db';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { mongoReadOps } from './mongo-reads';

/**
 * Keeps MongoDB in step with every PostgreSQL write to the tables listed in MIRRORED_MODELS
 * (docs/MONGODB.md › Writes kept in step). The PostgreSQL write runs as before, with its
 * triggers and constraints, and the rows it left are then written to MongoDB inside the same
 * MongoDB transaction, so both commit together. Reads still come from PostgreSQL until the
 * last step, which also turns the triggers into guards.
 *
 * The collections are made from the Prisma schema: the table's name, decimals as Decimal128,
 * the unique keys as unique indexes, and a validator for each column's type.
 */

type Field = Prisma.DMMF.Field;
type Model = Prisma.DMMF.Model;

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const ENUMS = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));

export interface MirrorInfo {
  model: string;
  delegate: string;
  def: AnyCollectionDef;
  pk: string[];
  scalars: Field[];
  tenant: boolean;
  /** Mirrored models whose rows PostgreSQL deletes or detaches when one of these is deleted. */
  children: { info: () => MirrorInfo; local: string[]; remote: string[]; onDelete: 'Cascade' | 'SetNull' }[];
}

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);
const tableOf = (m: Model) => m.dbName ?? m.name;

function bsonTypeOf(f: Field): Document {
  const nullable = !f.isRequired;
  let t: Document;
  if (f.kind === 'enum') t = { enum: [...(ENUMS.get(f.type) ?? []), ...(nullable ? [null] : [])] };
  else {
    const map: Record<string, string[]> = { String: ['string'], Int: ['int', 'long', 'double'], BigInt: ['long', 'int', 'double'], Float: ['double', 'int', 'long'], Decimal: ['decimal'], Boolean: ['bool'], DateTime: ['date'], Bytes: ['binData'] };
    if (f.type === 'Json') return {};
    t = { bsonType: [...(map[f.type] ?? ['string']), ...(nullable ? ['null'] : [])] };
  }
  return f.isList ? { bsonType: ['array', ...(nullable ? ['null'] : [])], items: t } : t;
}

function collectionFor(m: Model): AnyCollectionDef {
  const scalars = m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');
  // A table whose orgId is optional (error events, support) is shared, with orgId as a plain field.
  const tenant = scalars.some((f) => f.name === 'orgId' && f.isRequired);
  const properties: Document = {};
  for (const f of scalars) if (f.name !== 'orgId' || !tenant) properties[f.name] = bsonTypeOf(f);
  const byName = new Map(scalars.map((f) => [f.name, f]));
  const pk = pkOf(m);
  const uniques = [...m.uniqueFields, ...scalars.filter((f) => f.isUnique).map((f) => [f.name])].filter(
    (fields) => !(fields.length === 2 && fields.includes('orgId') && fields.some((x) => pk.includes(x) && x !== 'orgId')) && !(fields.length === 1 && pk.length === 1 && fields[0] === pk[0]),
  );
  const indexes = uniques.map((fields) => {
    const nullable = fields.filter((x) => !byName.get(x)?.isRequired);
    const partial = nullable.length ? Object.fromEntries(nullable.map((x) => [x, { $type: typeName(byName.get(x)!) }])) : undefined;
    return { key: Object.fromEntries(fields.map((x) => [x, 1])), name: `uniq_${fields.join('_')}`.slice(0, 120), unique: true, ...(partial ? { partialFilterExpression: partial } : {}) };
  });
  if (tenant) indexes.push({ key: { orgId: 1 }, name: 'org' } as never);
  return defineCollection({
    name: tableOf(m),
    scope: tenant ? 'tenant' : 'global',
    decimals: scalars.filter((f) => f.type === 'Decimal' && !f.isList).map((f) => f.name),
    schema: { bsonType: 'object', properties },
    indexes,
  });
}

function typeName(f: Field): string {
  const map: Record<string, string> = { String: 'string', Int: 'number', BigInt: 'number', Float: 'number', Decimal: 'decimal', Boolean: 'bool', DateTime: 'date', Bytes: 'binData' };
  return f.kind === 'enum' ? 'string' : (map[f.type] ?? 'string');
}

function pkOf(m: Model): string[] {
  if (m.primaryKey) return [...m.primaryKey.fields];
  return m.fields.filter((f) => f.isId).map((f) => f.name);
}

const INFOS = new Map<string, MirrorInfo>();
/** Children by parent table, from the PostgreSQL catalog (loadForeignKeys). */
const BY_TABLE = new Map<string, MirrorInfo['children']>();
let catalog: Promise<void> | undefined;


function build(name: string): MirrorInfo {
  const m = MODELS.get(name);
  if (!m) throw new Error(`No Prisma model ${name}`);
  const info: MirrorInfo = {
    model: name,
    delegate: lowerFirst(name),
    def: collectionFor(m),
    pk: pkOf(m),
    scalars: m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum'),
    tenant: m.fields.some((f) => f.name === 'orgId' && f.isRequired),
    children: [],
  };
  return info;
}

/** Registers the models whose writes are kept in step, and works out their cascades. */
export function mirrorModels(names: readonly string[]): MirrorInfo[] {
  for (const n of names) if (!INFOS.has(n)) INFOS.set(n, build(n));
  for (const info of INFOS.values()) info.children = [];
  // The catalog's keys are added again on the next delete.
  catalog = undefined;
  BY_TABLE.clear();
  for (const child of INFOS.values()) {
    const m = MODELS.get(child.model)!;
    for (const f of m.fields) {
      if (f.kind !== 'object' || !f.relationFromFields?.length || !INFOS.has(f.type)) continue;
      const onDelete = f.relationOnDelete as string | undefined;
      if (onDelete !== 'Cascade' && onDelete !== 'SetNull') continue;
      INFOS.get(f.type)!.children.push({ info: () => child, local: [...f.relationFromFields], remote: [...f.relationToFields!], onDelete });
    }
  }
  return names.map((n) => INFOS.get(n)!);
}

/** The mirrored model of this name, if it is mirrored. */
export const modelInfo = (name: string): MirrorInfo | undefined => INFOS.get(name);

export const mirrorByDelegate = () => new Map([...INFOS.values()].map((i) => [i.delegate, i]));

type Child = MirrorInfo['children'][number];

/**
 * Many foreign keys were written by hand in the SQL migrations (composite ones with org_id), so
 * the Prisma schema does not know what PostgreSQL deletes or detaches when a row goes. The
 * catalog does: it is read once, and its ON DELETE CASCADE and SET NULL keys whose child is a
 * mirrored table are added to the parents' children, also for parents moved by hand (documents,
 * journal entries) through `mirrorParentDeleted`.
 */

async function loadForeignKeys(tx: unknown): Promise<void> {
  catalog ??= (async () => {
    const rows = (await (tx as { $queryRawUnsafe: (q: string) => Promise<unknown[]> }).$queryRawUnsafe(`
      SELECT cl.relname AS child, pl.relname AS parent, c.confdeltype AS action,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS columns,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS parent_columns
        FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class pl ON pl.oid = c.confrelid
       WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n')`)) as { child: string; parent: string; action: string; columns: string[]; parent_columns: string[] }[];
    const byTable = new Map([...INFOS.values()].map((i) => [i.def.name, i]));
    const fieldOf = (scalars: Field[] | undefined, col: string) => scalars?.find((f) => (f.dbName ?? f.name) === col)?.name ?? (col === 'id' ? 'id' : col === 'org_id' ? 'orgId' : undefined);
    for (const r of rows) {
      const child = byTable.get(r.child);
      if (!child) continue;
      const parentModel = byTable.get(r.parent);
      const local = r.columns.map((c) => fieldOf(child.scalars, c));
      const remote = r.parent_columns.map((c) => fieldOf(parentModel?.scalars, c));
      if (local.some((x) => !x) || remote.some((x) => !x)) continue;
      const entry: Child = { info: () => child, local: local as string[], remote: remote as string[], onDelete: r.action === 'c' ? 'Cascade' : 'SetNull' };
      const list = parentModel?.children ?? (BY_TABLE.get(r.parent) ?? BY_TABLE.set(r.parent, []).get(r.parent)!);
      if (!list.some((x) => x.info() === child && x.local.join() === entry.local.join())) list.push(entry);
    }
  })();
  await catalog;
}

/**
 * Applies to MongoDB what PostgreSQL does to mirrored rows when rows of a table moved by hand
 * are deleted (a draft document's billing links go, a deleted draft journal's run loses its link).
 */
export async function mirrorParentDeleted(tx: unknown, store: Store, table: string, orgId: string, ids: string[]) {
  await loadForeignKeys(tx);
  for (const id of ids) await applyChildren(store, BY_TABLE.get(table) ?? [], orgId, { id, orgId });
}

// ------------------------------------------------------------------ the write path

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;
type Store = Pick<DocumentStore, 'collection'>;

const docId = (info: MirrorInfo, row: Record<string, unknown>) => info.pk.map((k) => String(row[k])).join(':');
const pkSelect = (info: MirrorInfo) => Object.fromEntries([...info.pk, ...(info.tenant ? ['orgId'] : [])].map((k) => [k, true]));
const pkWhere = (info: MirrorInfo, rows: Record<string, unknown>[]) =>
  info.pk.length === 1 ? { [info.pk[0]]: { in: rows.map((r) => r[info.pk[0]]) } } : { OR: rows.map((r) => Object.fromEntries(info.pk.map((k) => [k, r[k]]))) };

function forMongo(info: MirrorInfo, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of info.scalars) {
    if ((f.name === 'orgId' && info.tenant) || f.name === 'id') continue;
    let v = row[f.name];
    if (v === undefined) continue;
    if (v !== null && f.type === 'Decimal') v = f.isList ? (v as { toFixed(): string }[]).map((x) => x.toFixed()) : (v as { toFixed(): string }).toFixed();
    else if (v !== null && f.type === 'Bytes') v = Buffer.from(v as Uint8Array);
    else if (typeof v === 'bigint') v = Number(v);
    out[f.name] = v;
  }
  return out;
}

function inContext<T>(info: MirrorInfo, orgId: unknown, fn: () => Promise<T>): Promise<T> {
  return info.tenant ? runInOrg(String(orgId), fn) : runAsSystem(fn);
}

/** Writes these PostgreSQL rows (read back in full) into MongoDB. */
async function putRows(store: Store, d: Delegate, info: MirrorInfo, keys: Record<string, unknown>[]) {
  if (!keys.length) return;
  const rows = (await d.findMany({ where: pkWhere(info, keys) })) as Record<string, unknown>[];
  for (const r of rows) {
    await inContext(info, r.orgId, () => store.collection(info.def).updateOne({ id: docId(info, r) }, { $set: forMongo(info, r) }, { upsert: true }));
  }
}

async function dropRows(store: Store, info: MirrorInfo, keys: Record<string, unknown>[]) {
  for (const k of keys) {
    const id = docId(info, k);
    // The parent as MongoDB still has it: a foreign key may point at columns other than the id.
    const parent = ((await inContext(info, k.orgId, () => store.collection(info.def).findOne({ id }))) as Record<string, unknown> | null) ?? k;
    await applyChildren(store, info.children, k.orgId, parent);
    await inContext(info, k.orgId, () => store.collection(info.def).deleteOne({ id }));
  }
}

async function applyChildren(store: Store, children: Child[], orgId: unknown, parent: Record<string, unknown>) {
  for (const c of children) {
    const values = c.remote.map((r) => (r === 'id' ? (parent.id ?? parent._id) : parent[r]));
    if (values.some((v) => v === undefined || v === null)) continue;
    const match = Object.fromEntries(c.local.map((l, i) => [l, values[i]]));
    const child = c.info();
    const coll = () => store.collection(child.def);
    if (c.onDelete === 'SetNull') {
      const cleared = Object.fromEntries(c.local.filter((l) => l !== 'orgId').map((l) => [l, null]));
      await inContext(child, orgId, () => coll().updateMany(match, { $set: cleared }));
    } else {
      const gone = (await inContext(child, orgId, () => coll().find(match))) as Record<string, unknown>[];
      await dropRows(store, child, gone.map((g) => ({ ...g, orgId: g.orgId ?? orgId })));
    }
  }
}

/**
 * Nested writes (`lines: { create: [...] }`) change child rows too: those of mirrored child
 * models are read back by their foreign key and written to MongoDB, and children PostgreSQL no
 * longer has are removed.
 */
async function syncNested(tx: Record<string, Delegate>, store: Store, info: MirrorInfo, data: unknown, row: Record<string, unknown>) {
  if (!data || typeof data !== 'object') return;
  const m = MODELS.get(info.model)!;
  for (const f of m.fields) {
    if (f.kind !== 'object' || f.relationFromFields?.length || !(data as Record<string, unknown>)[f.name]) continue;
    const child = INFOS.get(f.type);
    if (!child) continue;
    const back = MODELS.get(f.type)!.fields.find((x) => x.kind === 'object' && x.relationName === f.relationName && x.relationFromFields?.length);
    if (!back) continue;
    const i = back.relationToFields!.findIndex((x) => x !== 'orgId');
    const fk = back.relationFromFields![i < 0 ? 0 : i];
    const parentKey = row[back.relationToFields![i < 0 ? 0 : i]];
    const cd = pgOf(tx[child.delegate]);
    const keep = (await cd.findMany({ where: { [fk]: parentKey }, select: pkSelect(child) })) as Record<string, unknown>[];
    const had = (await inContext(child, row.orgId, () => store.collection(child.def).find({ [fk]: parentKey }))) as Record<string, unknown>[];
    const kept = new Set(keep.map((k) => docId(child, k)));
    await dropRows(store, child, had.filter((h) => !kept.has(String(h.id))).map((h) => ({ ...h, orgId: h.orgId ?? row.orgId })));
    await putRows(store, cd, child, keep);
  }
}

/** Adds the primary key (and orgId) to a select, so the written rows can be found again. */
function withKeys(info: MirrorInfo, args: Record<string, unknown>) {
  if (!args.select) return { args, strip: [] as string[] };
  const select = { ...(args.select as Record<string, unknown>) };
  const strip: string[] = [];
  for (const k of Object.keys(pkSelect(info))) if (!select[k]) (select[k] = true), strip.push(k);
  return { args: { ...args, select }, strip };
}

const stripKeys = <T>(row: T, strip: string[]) => {
  if (!strip.length || !row || typeof row !== 'object') return row;
  const out = { ...(row as Record<string, unknown>) };
  for (const k of strip) delete out[k];
  return out as T;
};

/** A model delegate whose writes also land in MongoDB. Reads pass straight through. */
/**
 * Runs a transaction's MongoDB work one call at a time. PostgreSQL code often runs reads side by
 * side (`Promise.all`) inside a transaction; MongoDB refuses two operations at once in one.
 */
export function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
type Serial = ReturnType<typeof oneAtATime>;

export function mirroredDelegate(d: Delegate, info: MirrorInfo, store: Store, tx: Record<string, Delegate>, serial: Serial = oneAtATime()): Delegate {
  const ops: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    async create(args) {
      const { args: a, strip } = withKeys(info, args);
      const row = (await d.create(a)) as Record<string, unknown>;
      await putRows(store, d, info, [row]);
      await syncNested(tx, store, info, args.data, row);
      return stripKeys(row, strip);
    },
    async update(args) {
      const { args: a, strip } = withKeys(info, args);
      const row = (await d.update(a)) as Record<string, unknown>;
      await putRows(store, d, info, [row]);
      await syncNested(tx, store, info, args.data, row);
      return stripKeys(row, strip);
    },
    async upsert(args) {
      const { args: a, strip } = withKeys(info, args);
      const row = (await d.upsert(a)) as Record<string, unknown>;
      await putRows(store, d, info, [row]);
      await syncNested(tx, store, info, args.create, row);
      await syncNested(tx, store, info, args.update, row);
      return stripKeys(row, strip);
    },
    async delete(args) {
      await loadForeignKeys(tx);
      const { args: a, strip } = withKeys(info, args);
      const row = (await d.delete(a)) as Record<string, unknown>;
      await dropRows(store, info, [row]);
      return stripKeys(row, strip);
    },
    async createMany(args) {
      const rows = (await d.createManyAndReturn({ ...args, select: pkSelect(info) })) as Record<string, unknown>[];
      await putRows(store, d, info, rows);
      return { count: rows.length };
    },
    async createManyAndReturn(args) {
      const { args: a, strip } = withKeys(info, args);
      const rows = (await d.createManyAndReturn(a)) as Record<string, unknown>[];
      await putRows(store, d, info, rows);
      return rows.map((r) => stripKeys(r, strip));
    },
    async updateMany(args) {
      const keys = (await d.findMany({ where: args.where, select: pkSelect(info) })) as Record<string, unknown>[];
      const r = await d.updateMany(args);
      await putRows(store, d, info, keys);
      return r;
    },
    async updateManyAndReturn(args) {
      const keys = (await d.findMany({ where: args.where, select: pkSelect(info) })) as Record<string, unknown>[];
      const r = await d.updateManyAndReturn(args);
      await putRows(store, d, info, keys);
      return r;
    },
    async deleteMany(args) {
      await loadForeignKeys(tx);
      const keys = (await d.findMany({ where: args?.where, select: pkSelect(info) })) as Record<string, unknown>[];
      const r = await d.deleteMany(args);
      await dropRows(store, info, keys);
      return r;
    },
  };
  const reads = MONGO_READS() ? mongoReadOps(d, info, store) : {};
  return new Proxy(d, {
    get(target, prop, receiver) {
      if (prop === PG) return target;
      if (typeof prop === 'string' && prop in ops) return (args: Record<string, unknown>) => serial(() => ops[prop](args));
      if (typeof prop === 'string' && prop in reads) return (args: Record<string, unknown>) => serial(() => reads[prop](args));
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Copies rows a raw SQL statement (or a PostgreSQL trigger) wrote into MongoDB. Call it after
 * the statement, inside the same transaction.
 */
export async function mirrorRowsWhere(tx: unknown, store: Store, model: string, where: Record<string, unknown>) {
  const info = INFOS.get(model);
  if (!info) return;
  const d = pgOf((tx as Record<string, Delegate>)[info.delegate]);
  const keys = (await d.findMany({ where, select: pkSelect(info) })) as Record<string, unknown>[];
  await putRows(store, d, info, keys);
}

/**
 * Wraps a transaction client so writes to mirrored models also land in MongoDB. Outside a
 * transaction (`inTx` false), each such write runs in a transaction of its own, so both
 * databases commit together.
 */
export function mirrorClient<T extends object>(client: T, store: Store, runInTx?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>): T {
  const byDelegate = mirrorByDelegate();
  const cache = new Map<string, unknown>();
  const serial = oneAtATime();
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === '$executeRaw' || prop === '$executeRawUnsafe') {
        const run = value as (...a: unknown[]) => Promise<number>;
        return (...a: unknown[]) => {
          const table = writtenTable(prop === '$executeRawUnsafe' ? String(a[0]) : sqlText(a));
          if (!table) return run.apply(target, a);
          // Outside a transaction, run it in one so MongoDB is brought in step with it.
          if (runInTx) return runInTx((tx) => (tx as Record<string, (...x: unknown[]) => Promise<number>>)[prop](...a));
          return serial(async () => {
            const n = await run.apply(target, a);
            await syncAfterSql(receiver, store, table);
            return n;
          });
        };
      }
      if (typeof prop !== 'string' || !byDelegate.has(prop)) return value;
      if (!cache.has(prop)) {
        const info = byDelegate.get(prop)!;
        if (runInTx) {
          // Top-level client: run the write inside a transaction (whose client is wrapped).
          const pg = value as Delegate;
          const reads: Record<string, (a: unknown) => Promise<unknown>> = MONGO_READS() ? (mongoReadOps(pg, info, store) as never) : {};
          cache.set(prop, new Proxy(pg, {
            get(t, op, r) {
              if (op === PG) return t;
              if (typeof op === 'string' && WRITES.has(op)) return (args: unknown) => runInTx((tx) => ((tx as Record<string, Delegate>)[prop] as Delegate)[op](args));
              if (typeof op === 'string' && op in reads) return reads[op];
              return Reflect.get(t, op, r);
            },
          }));
        } else cache.set(prop, mirroredDelegate(value as Delegate, info, store, receiver as Record<string, Delegate>, serial));
      }
      return cache.get(prop);
    },
  });
}

// ------------------------------------------------------------------ raw SQL

const sqlText = (a: unknown[]): string => {
  const first = a[0] as { sql?: string; strings?: string[] } | string[];
  if (Array.isArray(first)) return first.join('?');
  return first?.sql ?? first?.strings?.join('?') ?? '';
};

/** The mirrored table a raw INSERT, UPDATE or DELETE writes, if it writes one. */
function writtenTable(sql: string): { info: MirrorInfo; deletes: boolean } | null {
  const m = /^\s*(?:(INSERT\s+INTO)|(UPDATE)|(DELETE\s+FROM))\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  if (!m) return null;
  const info = [...INFOS.values()].find((i) => i.def.name === m[4]);
  return info ? { info, deletes: !!m[3] } : null;
}

/**
 * After a raw write in a transaction: the rows it inserted or updated carry the transaction's
 * id in xmin, so they are found and written to MongoDB (with rows triggers changed in the same
 * transaction). After a raw DELETE, documents whose rows are gone are removed.
 */
async function syncAfterSql(tx: unknown, store: Store, { info, deletes }: { info: MirrorInfo; deletes: boolean }) {
  const q = tx as { $queryRawUnsafe<R>(sql: string): Promise<R> };
  const cols = info.pk.map((k) => `"${info.scalars.find((f) => f.name === k)?.dbName ?? k}"`);
  const orgCol = info.tenant ? `, "${info.scalars.find((f) => f.name === 'orgId')?.dbName ?? 'org_id'}" AS "orgId"` : '';
  const asKeys = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries([...info.pk.map((k, i) => [k, r[`k${i}`]]), ...(info.tenant ? [['orgId', r.orgId]] : [])]));
  const select = `SELECT ${cols.map((c, i) => `${c}::text AS "k${i}"`).join(', ')}${orgCol} FROM "${info.def.name}"`;
  const [{ before }] = await q.$queryRawUnsafe<{ before: string | null }[]>(`SELECT current_setting('t2t.bypass', true) AS before`);
  await q.$queryRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
  // No reset when this fails: the transaction is aborted then, and a reset would hide why.
  {
    if (deletes) {
      const kept = new Set(asKeys(await q.$queryRawUnsafe<Record<string, unknown>[]>(select)).map((k) => docId(info, k)));
      const docs = (await runAsSystem(() => store.collection(info.def).find({}, { projection: { _id: 1, ...(info.tenant ? { orgId: 1 } : {}), ...Object.fromEntries(info.pk.map((k) => [k, 1])) } }))) as Record<string, unknown>[];
      await dropRows(store, info, docs.filter((d) => !kept.has(String(d.id))));
    } else {
      const rows = await q.$queryRawUnsafe<Record<string, unknown>[]>(`${select} WHERE xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text`);
      await putRows(store, pgOf((tx as Record<string, Delegate>)[info.delegate]), info, asKeys(rows).map((k) => castKeys(info, k)));
    }
  }
  await q.$queryRawUnsafe(`SELECT set_config('t2t.bypass', '${before === 'on' ? 'on' : ''}', true)`);
}

/** Keys read as text, back in their column types for a Prisma where. */
function castKeys(info: MirrorInfo, k: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...k };
  for (const f of info.scalars) {
    if (!(f.name in out) || out[f.name] === null) continue;
    if (f.type === 'Int') out[f.name] = Number(out[f.name]);
    else if (f.type === 'BigInt') out[f.name] = BigInt(String(out[f.name]));
    else if (f.type === 'DateTime') out[f.name] = new Date(String(out[f.name]));
  }
  return out;
}

/** The PostgreSQL delegate behind a wrapped one: reading back what PostgreSQL holds must not go to MongoDB. */
const PG = Symbol('postgres delegate');
export const pgOf = (d: Delegate): Delegate => ((d as unknown as Record<symbol, Delegate>)[PG] ?? d);

/** Reads of mirrored tables come from MongoDB unless MONGO_READS=off (step 8). */
const MONGO_READS = () => process.env.MONGO_READS !== 'off';

const WRITES = new Set(['create', 'update', 'upsert', 'delete', 'createMany', 'createManyAndReturn', 'updateMany', 'updateManyAndReturn', 'deleteMany']);

/**
 * Copies the rows of every mirrored table that MongoDB does not have yet (db:copy-to-mongo).
 * Rows already there are left alone, so it is safe to run again.
 */
export async function copyMirroredTables(
  read: (model: string, page: { skip: number; take: number; orderBy: Record<string, 'asc'>[] }) => Promise<Record<string, unknown>[]>,
  store: Store,
  only?: readonly string[],
): Promise<Record<string, number>> {
  const copied: Record<string, number> = {};
  for (const info of INFOS.values()) {
    if (only && !only.includes(info.model)) continue;
    let n = 0;
    for (let skip = 0; ; skip += 1000) {
      const rows = await read(info.delegate, { skip, take: 1000, orderBy: info.pk.map((k) => ({ [k]: 'asc' as const })) });
      if (!rows.length) break;
      const ids = rows.map((r) => docId(info, r));
      const have = new Set(((await runAsSystem(() => store.collection(info.def).find({ id: { $in: ids } }, { projection: { id: 1 } }))) as { id: string }[]).map((d) => d.id));
      const fresh = rows.filter((r) => !have.has(docId(info, r)));
      if (fresh.length) await runAsSystem(() => store.collection(info.def).insertMany(fresh.map((r) => ({ id: docId(info, r), ...(info.tenant ? { orgId: r.orgId } : {}), ...forMongo(info, r) })) as never));
      n += fresh.length;
      if (rows.length < 1000) break;
    }
    copied[info.def.name] = n;
  }
  return copied;
}

/**
 * Compares every mirrored table with its collection (for one organisation, or all) and lists
 * what differs: rows missing on either side, and fields whose values differ. Empty = in step.
 */
export async function compareMirrored(
  read: (model: string, where: Record<string, unknown>) => Promise<Record<string, unknown>[]>,
  store: Store,
  orgIds?: string[],
): Promise<string[]> {
  const problems: string[] = [];
  const norm = (f: Field, v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (f.type === 'Decimal') return (Array.isArray(v) ? v : [v]).map((x) => new Prisma.Decimal(typeof x === 'string' ? x : (x as { toFixed(): string }).toFixed()).toFixed()).join(',');
    if (f.type === 'DateTime') return new Date(v as Date).toISOString();
    // A MongoDB Binary holds its bytes in .buffer; a Uint8Array's .buffer is the whole pool it sits in.
    if (f.type === 'Bytes') return Buffer.from((v as { _bsontype?: string })._bsontype === 'Binary' ? (v as { buffer: Uint8Array }).buffer : (v as Uint8Array)).toString('base64');
    // PostgreSQL gives a bigint, MongoDB a number or a Long.
    if (f.type === 'BigInt' || f.type === 'Int') return String(v);
    return JSON.stringify(v);
  };
  for (const info of INFOS.values()) {
    const hasOrg = info.scalars.some((f) => f.name === 'orgId');
    if (orgIds && !hasOrg) continue;
    const rows = await read(info.delegate, orgIds ? { orgId: { in: orgIds } } : {});
    const docs = (await runAsSystem(() => store.collection(info.def).find(orgIds ? { orgId: { $in: orgIds } } : {}))) as Record<string, unknown>[];
    const byId = new Map(docs.map((d) => [String(d.id), d]));
    for (const r of rows) {
      const d = byId.get(docId(info, r));
      if (!d) {
        problems.push(`${info.def.name} ${docId(info, r)}: missing in MongoDB`);
        continue;
      }
      byId.delete(docId(info, r));
      for (const f of info.scalars) {
        if (f.name === 'id') continue;
        if (norm(f, r[f.name]) !== norm(f, d[f.name])) problems.push(`${info.def.name} ${docId(info, r)}.${f.name}: ${String(norm(f, r[f.name]))} in PostgreSQL, ${String(norm(f, d[f.name]))} in MongoDB`);
      }
    }
    for (const id of byId.keys()) problems.push(`${info.def.name} ${id}: in MongoDB only`);
  }
  return problems;
}
