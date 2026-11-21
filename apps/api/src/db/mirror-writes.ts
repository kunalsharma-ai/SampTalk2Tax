import { Prisma } from '@talk2tax/database';
import { defineCollection, type AnyCollectionDef } from '@talk2tax/document-db';
type Document = Record<string, unknown>;
import type { DocumentStore } from '@talk2tax/document-db';
import { currentTenantContext, runAsSystem, runInOrg } from '../common/tenant-context';
import { appendFileSync } from 'node:fs';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { mongoReadOps, notFound } from './mongo-reads';
import { differences, flatWhere, FROM_SEQUENCE, fromSequence, hasAutoincrement, planCreate, planUpdate, useAutoincrement, type PlannedRow } from './mongo-writes';
import { foreignKeys } from './constraints/catalog';
import { enforceChecks, enforceNoReferrers, enforceReferences, keyIn, uniqueKeys, uniqueViolation, type TableInfo } from './constraints/enforce';
import { allowedInTx } from './guards/allow';
import { coordinationStore } from './counters';
import { changedExcept, strict, type GuardContext, type Reader } from './guards/guard';
import { asColumns, GUARDS } from './guards';
import './guards/rules';

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
  /** For lines kept inside their parent's document (document lines, journal lines). */
  embedded?: { parent: AnyCollectionDef; path: string; parentKey: string };
  /** Moved by hand (MovedTables, the ledger): only reads go through here, writes stay as they are. */
  readOnly?: boolean;
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
  // A numeric id is kept as text in _id (docId) and as a number in idNumber, for order and ranges.
  if (numericId(m)) {
    properties.idNumber = { bsonType: ['long', 'int', 'double'] };
    indexes.push({ key: { idNumber: 1 }, name: 'id_number' } as never);
  }
  if (tenant) indexes.push({ key: { orgId: 1 }, name: 'org' } as never);
  return defineCollection({
    name: tableOf(m),
    scope: tenant ? 'tenant' : 'global',
    decimals: scalars.filter((f) => f.type === 'Decimal' && !f.isList).map((f) => f.name),
    schema: { bsonType: 'object', properties },
    indexes,
  });
}

/** A table keyed by a sequence number (audit events, usage events): `id` is Int or BigInt. */
export function numericId(m: Model): boolean {
  const pk = pkOf(m);
  return pk.length === 1 && pk[0] === 'id' && ['Int', 'BigInt'].includes(m.fields.find((f) => f.name === 'id')!.type);
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
  TABLES.clear();
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

const READABLE = new Map<string, MirrorInfo>();
const TABLES = new Map<string, TableInfo>();

/**
 * Registers tables moved by hand (step 6 and before) for reading: their MongoDB documents have
 * the Prisma model's fields, so the same reader serves them. Lines kept inside a parent
 * document name the parent collection, the array and the parent's key.
 */
export function readableModels(list: { model: string; def: AnyCollectionDef; embedded?: MirrorInfo['embedded'] }[]) {
  TABLES.clear();
  for (const r of list) {
    const info = { ...build(r.model), def: r.def, embedded: r.embedded, readOnly: true };
    if (r.embedded) info.tenant = r.embedded.parent.scope === 'tenant';
    else info.tenant = r.def.scope === 'tenant';
    READABLE.set(r.model, info);
  }
}

/** A model's table as the constraints see it (mirrored or moved by hand). */
function tableInfoOf(info: MirrorInfo): TableInfo {
  const m = MODELS.get(info.model)!;
  const table = m.dbName ?? m.name;
  return { table, def: info.def, field: (c) => info.scalars.find((f) => (f.dbName ?? f.name) === c)?.name, embedded: info.embedded };
}
/** The table of this name, if MongoDB holds it. */
function tableNamed(table: string): TableInfo | undefined {
  if (!TABLES.size) for (const info of [...READABLE.values(), ...INFOS.values()]) TABLES.set(tableInfoOf(info).table, tableInfoOf(info));
  return TABLES.get(table);
}

/** Whether MongoDB holds this record of a table (by id, and organisation when given): what a lock needs to know. */
export async function tableHolder(client: unknown, table: string, id: string, orgId?: string): Promise<boolean> {
  const t = tableNamed(table);
  if (!t) throw new Error(`${table} is not held in MongoDB`);
  const field = t.embedded ? `${t.embedded.path}.id` : 'id';
  const filter: Record<string, unknown> = { [field]: id, ...(orgId !== undefined ? { orgId } : {}) };
  const store = storeOf(client);
  if (!store) throw new Error('No MongoDB store for locks');
  return runAsSystem(async () => !!(await store.collection(t.embedded ? t.embedded.parent : t.def).findOne(filter, { projection: { _id: 1 } })));
}
let lockStore: Store | undefined;
/** The store locks look records up in when the client does not say (set at start-up). */
export function useLockStore(s: Store) {
  lockStore = s;
}

const STORE = Symbol.for('talk2tax.documentStore');
/**
 * The MongoDB store a (transaction) client writes through: locks, numbering and lookups made
 * for a transaction go through it, so they are part of that transaction (an API process can
 * hold more than one app, as the tests do).
 */
export function storeOf<S = Store>(client: unknown): S | undefined {
  return ((client as Record<symbol, unknown> | null | undefined)?.[STORE] as S | undefined) ?? (lockStore as S | undefined);
}

/**
 * Claims up to `take` records of a model that match `due` (a MongoDB filter on field names),
 * soonest `order` first, by setting `lease` on each: one process gets each record, as with
 * UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED). Outside any transaction.
 */
export async function claimRecords(client: unknown, model: string, due: Record<string, unknown>, order: string, take: number, lease: Record<string, unknown>): Promise<{ id: string; org_id: string }[]> {
  const info = modelInfo(model);
  const store = storeOf(client);
  if (!info || !store) throw new Error(`${model} cannot be claimed in MongoDB`);
  const coll = store.collection(info.def);
  return runAsSystem(async () => {
    const out: { id: string; org_id: string }[] = [];
    for (const c of (await coll.find(due, { sort: { [order]: 1 }, limit: take, projection: { _id: 1 } })) as { id: string }[]) {
      const got = (await coll.findOneAndUpdate({ ...due, id: c.id }, { $set: lease })) as { id: string; orgId: string } | null;
      if (got) out.push({ id: String(got.id), org_id: String(got.orgId) });
    }
    return out;
  });
}

/** The model of this name as MongoDB holds it: mirrored, or moved by hand. */
export const modelInfo = (name: string): MirrorInfo | undefined => INFOS.get(name) ?? READABLE.get(name);
export const readableByDelegate = () => new Map([...READABLE.values()].map((i) => [i.delegate, i]));

export const mirrorByDelegate = () => new Map([...INFOS.values()].map((i) => [i.delegate, i]));

type Child = MirrorInfo['children'][number];

/**
 * Many foreign keys were written by hand in the SQL migrations (composite ones with org_id), so
 * the Prisma schema does not know what PostgreSQL deletes or detaches when a row goes. The
 * catalog does: it is read once, and its ON DELETE CASCADE and SET NULL keys whose child is a
 * mirrored table are added to the parents' children, also for parents moved by hand (documents,
 * journal entries) through `cascadeDeleted`.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function loadForeignKeys(_tx?: unknown): Promise<void> {
  catalog ??= (async () => {
    const rows = foreignKeys()
      .filter((k) => k.onDelete === 'CASCADE' || k.onDelete === 'SET NULL')
      .map((k) => ({ child: k.table, parent: k.references, action: k.onDelete === 'CASCADE' ? 'c' : 'n', columns: k.columns, parent_columns: k.referencedColumns }));
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
 * Applies the foreign keys' ON DELETE actions to the rows that point at deleted rows of a table
 * moved by hand (a draft document's billing links go, a deleted draft journal's run loses its link).
 */
export async function cascadeDeleted(tx: unknown, store: Store, table: string, orgId: string, ids: string[]) {
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
  if (row.id !== undefined && row.id !== null && numericId(MODELS.get(info.model)!)) out.idNumber = Number(row.id);
  return out;
}

function inContext<T>(info: MirrorInfo, orgId: unknown, fn: () => Promise<T>): Promise<T> {
  return info.tenant ? runInOrg(String(orgId), fn) : runAsSystem(fn);
}


/**
 * Writes one record (by field name, complete) into MongoDB after its guard, CHECK constraints
 * and foreign keys. `insert` refuses a record whose key is already there, as an INSERT would.
 */
async function storeRow(store: Store, info: MirrorInfo, r: Record<string, unknown>, mode: 'checked' | 'changed' | 'insert', guard = allowedInTx('guards_off') ? undefined : GUARDS[info.model]) {
  writePolicy(info, r);
  const before = (await beforeRow(info, store, r)) as Record<string, unknown> | null;
  if (info.readOnly) return storeMoved(store, info, r, mode === 'insert' || !before);
  if (mode === 'insert' && before) throw duplicateKey(info, info.pk);
  if (guard && (mode !== 'changed' || !before || changedExcept(before, r, []))) {
    await inContext(info, r.orgId, async () => await guard(before ? 'UPDATE' : 'INSERT', strict(asColumns(info.model, before), info.model), strict(asColumns(info.model, r), info.model), guardContext(store)));
  }
  // The table's CHECK constraints and foreign keys, as PostgreSQL enforced them.
  const t = tableInfoOf(info);
  const cols = asColumns(info.model, r)!;
  enforceChecks(t.table, cols);
  await enforceReferences(store, t, cols, tableNamed, asColumns(info.model, before));
  await enforceUniques(store, info, t.table, r, cols);
  try {
    await inContext(info, r.orgId, () => store.collection(info.def).updateOne({ id: docId(info, r) }, { $set: forMongo(info, r) }, { upsert: true }));
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    const pattern = Object.keys((e as { keyPattern?: Record<string, unknown> }).keyPattern ?? {});
    throw duplicateKey(info, pattern.map((x) => (x === 'id' ? info.pk : [x])).flat());
  }
}

/**
 * A record of a table moved by hand, written through its collection (whose guards are its
 * rules). Only with PostgreSQL off: before that its writes go through MovedTables.
 */
async function storeMoved(store: Store, info: MirrorInfo, r: Record<string, unknown>, insert: boolean) {
  if (info.embedded) throw new Error(`${info.model} is written with its ${info.embedded.parent.name} record`);
  const doc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined) doc[k] = Prisma.Decimal.isDecimal(v) ? (v as Prisma.Decimal).toFixed() : v;
  try {
    if (insert) await inContext(info, r.orgId, () => store.collection(info.def).insertOne(doc as never));
    else {
      const { id, orgId: _org, ...set } = doc;
      await inContext(info, r.orgId, () => store.collection(info.def).updateOne({ id } as never, { $set: set } as never));
    }
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    const pattern = Object.keys((e as { keyPattern?: Record<string, unknown> }).keyPattern ?? {});
    throw duplicateKey(info, pattern.map((x) => (x === 'id' ? info.pk : [x])).flat());
  }
}

/**
 * Row-level security's WITH CHECK, for writes with PostgreSQL off (docs/SECURITY.md ›
 * Row-level security): outside system work a record must belong to the current organisation,
 * a copilot conversation to the current member, and the benchmark pool is the system's alone.
 */
function writePolicy(info: MirrorInfo, r: Record<string, unknown>) {
  const c = currentTenantContext();
  if (c.bypass) return;
  const ok =
    info.model === 'BenchmarkContribution'
      ? false
      : (!(info.tenant || ['AuditEvent', 'ErrorEvent'].includes(info.model)) || (!!c.orgId && r.orgId === c.orgId)) && (info.model !== 'CopilotConversation' || (!!c.userId && r.userId === c.userId));
  if (!ok) throw new Error(`new row violates row-level security policy for table "${info.def.name}"`);
}

/**
 * The unique indexes MongoDB's own indexes do not hold (partial, on expressions, or written by
 * hand in SQL): no other record of the table may have the same key. A lock document on the key
 * makes two transactions writing it take turns, so the second sees the first's record.
 */
async function enforceUniques(store: Store, info: MirrorInfo, table: string, r: Record<string, unknown>, cols: Record<string, unknown>) {
  const m = MODELS.get(info.model)!;
  const fieldOf = (c: string) => info.scalars.find((f) => (f.dbName ?? f.name) === c)?.name;
  const covered = (columns: string[]) => {
    const fields = columns.map(fieldOf);
    if (fields.some((f) => !f)) return false;
    const set = new Set(fields as string[]);
    if (info.pk.every((k) => set.has(k))) return true;
    return m.uniqueFields.some((u) => u.length === set.size && u.every((x) => set.has(x))) || (set.size === 1 && info.scalars.some((f) => f.isUnique && set.has(f.name)));
  };
  for (const { index, key, plain } of uniqueKeys(table, cols, covered)) {
    await coordinationStore()?.lock(`unique:${index.name}:${key}`);
    const where = Object.fromEntries(Object.keys(plain).map((c) => [fieldOf(c)!, r[fieldOf(c)!]]));
    const others = (await runAsSystem(() => guardReads(info, store).findMany({ where: { ...where, ...(info.tenant ? { orgId: r.orgId } : {}) } }))) as Record<string, unknown>[];
    for (const o of others) if (docId(info, o) !== docId(info, r) && keyIn(index, asColumns(info.model, o)!) === key) throw uniqueViolation(index);
  }
}

/** As Prisma reports a unique constraint failed (P2002), with the fields of the key. */
function duplicateKey(info: MirrorInfo, fields: string[]) {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (${fields.map((f) => `\`${f}\``).join(',')})`, {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: info.model, target: fields },
  });
}

/**
 * The record as MongoDB has it, whoever is asking: a trigger is handed OLD, so row policies
 * narrower than the organisation (a member's own copilot conversations) do not hide it.
 */
function beforeRow(info: MirrorInfo, store: Store, key: Record<string, unknown>) {
  return runAsSystem(() => guardReads(info, store).findFirst({ where: { ...pkWhere(info, [key]), ...(info.tenant ? { orgId: key.orgId } : {}) } }));
}

/** Reads for guards: straight from MongoDB (they run inside the write, so not through its queue). */
function guardReads(info: MirrorInfo, store: Store) {
  return mongoReadOps(info, store) as unknown as { findFirst(a: unknown): Promise<unknown>; findMany(a: unknown): Promise<unknown>; count(a: unknown): Promise<unknown> };
}

/** Records of a model (by its delegate name) as Prisma gives them, read from MongoDB alone. */
export function mongoRows(store: Store, delegate: string, where: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const info = mirrorByDelegate().get(delegate) ?? readableByDelegate().get(delegate);
  if (!info) throw new Error(`${delegate} is not held in MongoDB`);
  return runAsSystem(() => guardReads(info, store).findMany({ where })) as Promise<Record<string, unknown>[]>;
}

function guardContext(store: Store): GuardContext {
  const db = new Proxy({} as Reader, {
    get(_t, prop) {
      const info = typeof prop === 'string' ? (mirrorByDelegate().get(prop) ?? readableByDelegate().get(prop)) : undefined;
      if (!info) throw new Error(`Guards cannot read ${String(prop)}`);
      return guardReads(info, store);
    },
  });
  return { db, allowed: allowedInTx };
}

async function dropRows(store: Store, info: MirrorInfo, keys: Record<string, unknown>[]) {
  for (const k of keys) {
    const id = docId(info, k);
    // The parent as MongoDB still has it: a foreign key may point at columns other than the id.
    const parent = ((await inContext(info, k.orgId, () => store.collection(info.def).findOne({ id }))) as Record<string, unknown> | null) ?? k;
    const guard = allowedInTx('guards_off') ? undefined : GUARDS[info.model];
    if (guard) {
      const before = (await beforeRow(info, store, k)) as Record<string, unknown> | null;
      if (before) await inContext(info, k.orgId, async () => await guard('DELETE', strict(asColumns(info.model, before), info.model), null, guardContext(store)));
    }
    // As in PostgreSQL, a cascade reaches the children after the parent is gone, so their guards no longer see it.
    await inContext(info, k.orgId, () => store.collection(info.def).deleteOne({ id }));
    await applyChildren(store, info.children, k.orgId, parent);
    await enforceNoReferrers(store, tableInfoOf(info), asColumns(info.model, parent)!, tableNamed);
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


// ------------------------------------------------------------------ MongoDB alone


/** Next value of an autoincrement column, from a MongoDB sequence raised once to the highest value held. */
const raisedSerials = new Set<string>();
export async function nextSerial(store: Store, model: string, field: string): Promise<number> {
  const info = modelInfo(model)!;
  const own = store as Partial<Pick<DocumentStore, 'nextSerial' | 'raiseSequence'>>;
  const seq = own.nextSerial && own.raiseSequence ? (own as Pick<DocumentStore, 'nextSerial' | 'raiseSequence'>) : coordinationStore();
  if (!seq) throw new Error(`${model}.${field} needs MongoDB's sequences`);
  const name = `serial:${info.def.name}.${field}`;
  if (!raisedSerials.has(name)) {
    const path = field === 'id' ? 'idNumber' : field;
    const [top] = await runAsSystem(() => store.collection(info.def).aggregate<{ top: number | null }>([{ $group: { _id: null, top: { $max: `$${path}` } } }]));
    if (top?.top) await seq.raiseSequence(name, Number(top.top));
    raisedSerials.add(name);
  }
  // Taken outside the transaction: serial ids (audit events and the like) are shared by every
  // organisation, so taking them inside would make all writing transactions conflict on one
  // document (QA-017 found this). Order within an organisation still holds, because audit
  // appends take the organisation's chain lock first and keep it until they commit.
  return seq.nextSerial(name);
}

type Row = Record<string, unknown>;

export type Ops = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

/**
 * The writes of a mirrored model with PostgreSQL out of the way: each is planned
 * (mongo-writes.ts), checked as the database checked it (guards, CHECK constraints, foreign
 * keys, unique keys) and stored; the result is read back in the shape the caller asked for.
 */
export function mongoOnlyOps(info: MirrorInfo, store: Store, reads: Ops): Ops {
  const shape = (args: Row) => ({ ...(args.select ? { select: args.select } : {}), ...(args.include ? { include: args.include } : {}) });
  const shaped = (row: Row, args: Row) => reads.findFirst({ where: keyOf(info, row), ...shape(args) });
  const write = async (plans: PlannedRow[]) => {
    for (const p of plans) {
      const target = modelInfo(p.model);
      if (!target) throw new Error(`${p.model} is not held in MongoDB`);
      await storeRow(store, target, p.row, p.before ? 'checked' : 'insert');
    }
  };
  const create = async (data: Row) => {
    const plans = await planCreate(info.model, data, new Date());
    await write(plans);
    return plans[0].row;
  };
  const update = async (before: Row, data: Row) => {
    const u = await planUpdate(info.model, before, data, new Date());
    for (const del of u.nestedDeletes) {
      const child = modelInfo(del.model)!;
      const gone = (await guardReads(child, store).findMany({ where: del.where })) as Row[];
      await dropRows(store, child, gone);
    }
    await write([{ model: info.model, row: u.row, before }, ...u.children]);
    return u.row;
  };
  const remove = async (rows: Row[]) => {
    await loadForeignKeys();
    await dropRows(store, info, rows);
  };
  const createRows = async (args: Row) => {
    const out: Row[] = [];
    for (const data of ([] as Row[]).concat((args.data ?? []) as Row[])) {
      try {
        out.push(await create({ ...data }));
      } catch (e) {
        if (!(args.skipDuplicates && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    return out;
  };
  const updateRows = async (args: Row) => {
    const out: Row[] = [];
    for (const before of (await reads.findMany({ where: args.where ?? {} })) as Row[]) out.push(await update(before, args.data as Row));
    return out;
  };
  const first = (args: Row) => reads.findFirst({ where: flatWhere(info.model, (args.where ?? {}) as Row) }) as Promise<Row | null>;
  return {
    async create(args) {
      return shaped(await create(args.data as Row), args);
    },
    async update(args) {
      const before = await first(args);
      if (!before) throw notFound(info.model, 'Record to update not found.');
      return shaped(await update(before, args.data as Row), args);
    },
    async upsert(args) {
      const before = await first(args);
      return shaped(before ? await update(before, args.update as Row) : await create(args.create as Row), args);
    },
    async delete(args) {
      const before = await first(args);
      if (!before) throw notFound(info.model, 'Record to delete does not exist.');
      const result = await shaped(before, args);
      await remove([before]);
      return result;
    },
    async deleteMany(args) {
      const rows = (await reads.findMany({ where: args.where ?? {} })) as Row[];
      await remove(rows);
      return { count: rows.length };
    },
    async createMany(args) {
      return { count: (await createRows(args)).length };
    },
    async createManyAndReturn(args) {
      const rows = await createRows(args);
      return rows.length ? reads.findMany({ where: pkWhere(info, rows), ...shape(args) }) : [];
    },
    async updateMany(args) {
      return { count: (await updateRows(args)).length };
    },
    async updateManyAndReturn(args) {
      const rows = await updateRows(args);
      return rows.length ? reads.findMany({ where: pkWhere(info, rows), ...shape(args) }) : [];
    },
  };
}

const keyOf = (info: MirrorInfo, row: Row) => Object.fromEntries(info.pk.map((k) => [k, row[k]]));

