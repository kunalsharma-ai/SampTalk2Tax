import { Prisma } from '@talk2tax/database';
import type { DocumentStore } from '@talk2tax/document-db';
import { Binary, Decimal128, Long } from '@talk2tax/document-db';
import { currentTenantContext, runAsSystem } from '../common/tenant-context';
import { modelInfo, type MirrorInfo } from './mirror-writes';

/**
 * Step 8: reads of mirrored tables answered from MongoDB (docs/MONGODB.md › Reads).
 *
 * A Prisma read (`findMany`, `findFirst`, `findUnique`, their `OrThrow` forms and `count`) is
 * turned into a MongoDB query when everything it asks for can be: the filters Prisma code here
 * uses (equals, in, comparisons, contains, null checks, AND/OR/NOT, relation filters through
 * mirrored tables), ordering with PostgreSQL's null placement, paging, scalar selects, and
 * includes of mirrored relations. The rows come back shaped as Prisma returns them: decimals as
 * Prisma.Decimal, bigints as bigint, bytes as Uint8Array.
 *
 * Anything else (a relation to a table moved by hand, `distinct`, cursors, `_count`, JSON
 * filters) still goes to PostgreSQL and is counted in `readFallbacks()`, the list of what is
 * left to move before PostgreSQL goes.
 */

type Doc = Record<string, unknown>;
type Store = Pick<DocumentStore, 'collection'>;
type Field = Prisma.DMMF.Field;

/** Thrown while translating: this query stays on PostgreSQL for now. */
class Untranslatable extends Error {}
const no = (why: string): never => {
  throw new Untranslatable(why);
};

const FALLBACKS = new Map<string, number>();
/** What still reads PostgreSQL, by model and reason, with how often it happened. */
export const readFallbacks = () => new Map(FALLBACKS);

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const ENUM_VALUES = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));

// ------------------------------------------------------------------ filters

const SCALAR_OPS = new Set(['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'contains', 'startsWith', 'endsWith', 'mode']);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scalarValue(f: Field, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (f.type === 'Decimal') return Decimal128.fromString(typeof v === 'object' && v !== null && 'toFixed' in v ? (v as Prisma.Decimal).toFixed() : String(v));
  if (f.type === 'BigInt') return Number(v);
  if (f.type === 'DateTime') return v instanceof Date ? v : new Date(String(v));
  if (f.type === 'Bytes' || f.type === 'Json') no(`filter on ${f.type}`);
  return v;
}

function scalarFilter(f: Field, cond: unknown): Doc {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date || Prisma.Decimal.isDecimal(cond)) {
    if (f.isList) no('list equality');
    return { [f.name]: scalarValue(f, cond) };
  }
  const c = cond as Doc;
  if (f.type === 'Json' && !f.isList && Array.isArray(c.path) && Object.keys(c).every((k) => k === 'path' || k === 'equals')) {
    // A value inside a JSON field, compared with a plain string, number or boolean.
    const path = c.path as unknown[];
    const v = c.equals;
    if (!path.length || path.some((x) => typeof x !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) || !['string', 'number', 'boolean'].includes(typeof v)) no('JSON path filter');
    return { [`${f.name}.${path.join('.')}`]: v };
  }
  if (f.isList) {
    if ('has' in c) return { [f.name]: scalarValue(f, c.has) };
    if ('hasSome' in c) return { [f.name]: { $in: (c.hasSome as unknown[]).map((x) => scalarValue(f, x)) } };
    if ('isEmpty' in c) return c.isEmpty ? { [f.name]: { $size: 0 } } : { [`${f.name}.0`]: { $exists: true } };
    no('list filter');
  }
  for (const k of Object.keys(c)) if (!SCALAR_OPS.has(k)) no(`operator ${k}`);
  const out: Doc[] = [];
  const insensitive = c.mode === 'insensitive';
  const ops: Doc = {};
  if ('equals' in c) {
    if (insensitive && typeof c.equals === 'string') out.push({ [f.name]: { $regex: `^${escapeRe(c.equals)}$`, $options: 'i' } });
    else ops.$eq = scalarValue(f, c.equals);
  }
  if ('in' in c) ops.$in = (c.in as unknown[]).map((x) => scalarValue(f, x));
  if ('notIn' in c) ops.$nin = (c.notIn as unknown[]).map((x) => scalarValue(f, x));
  for (const [p, m] of [['lt', '$lt'], ['lte', '$lte'], ['gt', '$gt'], ['gte', '$gte']] as const) {
    if (p in c && c[p] !== undefined) ops[m] = scalarValue(f, c[p]);
  }
  const text = (k: 'contains' | 'startsWith' | 'endsWith', s: unknown) => {
    const e = escapeRe(String(s));
    const re = k === 'contains' ? e : k === 'startsWith' ? `^${e}` : `${e}$`;
    return { [f.name]: { $regex: re, ...(insensitive ? { $options: 'i' } : {}) } };
  };
  for (const k of ['contains', 'startsWith', 'endsWith'] as const) if (k in c && c[k] !== undefined) out.push(text(k, c[k]));
  if ('not' in c) {
    const n = c.not;
    // PostgreSQL's `<> x` leaves out NULLs; MongoDB's $ne keeps them.
    if (n === null) ops.$ne = null;
    else if (typeof n === 'object' && !(n instanceof Date) && !Prisma.Decimal.isDecimal(n)) out.push({ $nor: [scalarFilter(f, n)], [f.name]: { $ne: null } });
    else out.push({ [f.name]: { $nin: [scalarValue(f, n), null] } });
  }
  // Comparisons and IN never match NULL in PostgreSQL; in MongoDB $nin does, so rule it out.
  if (ops.$nin) out.push({ [f.name]: { $ne: null } });
  if (Object.keys(ops).length) out.push({ [f.name]: ops });
  if (!out.length) return {};
  return out.length === 1 ? out[0] : { $and: out };
}

/** Turns a Prisma `where` on `info`'s model into a MongoDB filter (relation filters become id lists). */
async function toFilter(store: Store, info: MirrorInfo, where: unknown): Promise<Doc> {
  if (!where) return {};
  const m = MODELS.get(info.model)!;
  const parts: Doc[] = [];
  for (const [key, cond] of Object.entries(where as Doc)) {
    if (cond === undefined) continue;
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      const list = (Array.isArray(cond) ? cond : [cond]) as unknown[];
      const subs: Doc[] = [];
      for (const w of list) subs.push(await toFilter(store, info, w));
      if (key === 'AND') parts.push(...subs);
      else if (key === 'OR') parts.push(subs.length ? { $or: subs } : { _id: { $exists: false } });
      else if (subs.length) parts.push({ $nor: subs });
      continue;
    }
    const f = m.fields.find((x) => x.name === key);
    if (!f) {
      // A compound unique key: { orgId_code: { orgId, code } }.
      const keys = [...m.uniqueIndexes.map((u) => ({ n: u.name ?? u.fields.join('_'), fs: u.fields })), ...(m.primaryKey ? [{ n: m.primaryKey.name ?? m.primaryKey.fields.join('_'), fs: m.primaryKey.fields }] : [])];
      if (!keys.some((c) => c.n === key) || typeof cond !== 'object' || cond === null) no(`unknown field ${key}`);
      parts.push(await toFilter(store, info, cond));
      continue;
    }
    if (f.name === 'id' && f.type !== 'String') parts.push(...numericIdFilter(f, cond));
    else if (f.kind === 'scalar' || f.kind === 'enum') parts.push(scalarFilter(f, cond));
    else parts.push(await relationFilter(store, info, f, cond));
  }
  const clean = parts.filter((p) => Object.keys(p).length);
  if (!clean.length) return {};
  return clean.length === 1 ? clean[0] : { $and: clean };
}

/**
 * A numeric id is stored as its text in _id (see docId) and as a number in idNumber: equality
 * and lists compare the text, ranges the number.
 */
function numericIdFilter(f: Field, cond: unknown): Doc[] {
  if (cond === null || typeof cond !== 'object') return [scalarFilter({ ...f, type: 'String' } as Field, stringIds(cond))];
  const text: Doc = {};
  const range: Doc = {};
  for (const [k, v] of Object.entries(cond as Doc)) {
    if (['gt', 'gte', 'lt', 'lte'].includes(k)) range[`$${k}`] = Number(v);
    else text[k] = v;
  }
  return [...(Object.keys(text).length ? [scalarFilter({ ...f, type: 'String' } as Field, stringIds(text))] : []), ...(Object.keys(range).length ? [{ idNumber: range }] : [])];
}

/** A numeric id is stored as its text in _id (see docId), so filters on it compare text. */
function stringIds(cond: unknown): unknown {
  if (cond === null || typeof cond !== 'object') return cond === null || cond === undefined ? cond : String(cond);
  const out: Doc = {};
  for (const [k, v] of Object.entries(cond as Doc)) out[k] = Array.isArray(v) ? v.map((x) => String(x)) : k === 'not' ? stringIds(v) : v === null || v === undefined || typeof v === 'object' ? v : String(v);
  return out;
}

interface Link {
  target: MirrorInfo;
  /** The fields on this side and the matching fields on the target, without orgId. */
  local: string[];
  remote: string[];
  many: boolean;
}

/** How a relation field joins: which fields on each side, and whether it is a list. */
function linkOf(info: MirrorInfo, f: Field): Link {
  const target = modelInfo(f.type);
  if (!target) no(`relation to ${f.type}, which is not mirrored`);
  // orgId is dropped from compound keys (the organisation is already fixed by the read), unless
  // it is the whole key, as on the relations to the organisation itself.
  const pairs = (from: readonly string[], to: readonly string[]) => {
    const all = from.map((x, i) => [x, to[i]] as const);
    const rest = all.filter(([x, y]) => x !== 'orgId' && y !== 'orgId');
    return rest.length ? rest : all;
  };
  if (f.relationFromFields?.length) {
    const p = pairs(f.relationFromFields, f.relationToFields!);
    return { target: target!, local: p.map((x) => x[0]), remote: p.map((x) => x[1]), many: false };
  }
  const back = MODELS.get(f.type)!.fields.find((x) => x.kind === 'object' && x.relationName === f.relationName && x.relationFromFields?.length && x !== f);
  if (!back) no(`relation ${info.model}.${f.name} without a foreign key`);
  const p = pairs(back!.relationFromFields!, back!.relationToFields!);
  return { target: target!, local: p.map((x) => x[1]), remote: p.map((x) => x[0]), many: f.isList };
}

async function idsMatching(store: Store, link: Link, where: unknown): Promise<unknown[]> {
  if (link.remote.length !== 1) no('relation filter on a compound key');
  const filter = await toFilter(store, link.target, where);
  const rows = await read(store, link.target, filter, { projection: { [link.remote[0]]: 1 } });
  return [...new Set(rows.map((r) => r[link.remote[0]]))].filter((x) => x !== null && x !== undefined);
}

async function relationFilter(store: Store, info: MirrorInfo, f: Field, cond: unknown): Promise<Doc> {
  const link = linkOf(info, f);
  if (link.local.length !== 1) no('relation filter on a compound key');
  const local = link.local[0];
  if (!link.many) {
    if (cond === null) return { [local]: null };
    const c = cond as Doc;
    if ('is' in c || 'isNot' in c) {
      if ('is' in c) return c.is === null ? { [local]: null } : { [local]: { $in: await idsMatching(store, link, c.is) } };
      return c.isNot === null ? { [local]: { $ne: null } } : { [local]: { $nin: await idsMatching(store, link, c.isNot), $ne: null } };
    }
    return { [local]: { $in: await idsMatching(store, link, c) } };
  }
  const c = cond as Doc;
  if ('some' in c) return { [local]: { $in: await idsMatching(store, link, c.some) } };
  if ('none' in c) return { [local]: { $nin: await idsMatching(store, link, c.none) } };
  return no('every on a relation');
}

// ------------------------------------------------------------------ ordering

type Order = [string, 1 | -1, ('first' | 'last')?];

function orderOf(info: MirrorInfo, orderBy: unknown): Order[] {
  if (!orderBy) return [];
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Doc[];
  const m = MODELS.get(info.model)!;
  const out: Order[] = [];
  for (const o of list) {
    for (const [k, d] of Object.entries(o)) {
      const f = m.fields.find((x) => x.name === k);
      if (f && f.kind === 'object') {
        if (f.isList) no(`ordering by ${k}`);
        out.push(...orderOf(modelInfo(f.type) ?? no(`ordering by ${k}`), d).map(([x, dir, nulls]) => [`${k}.${x}`, dir, nulls] as Order));
        continue;
      }
      if (!f || (f.kind !== 'scalar' && f.kind !== 'enum')) no(`ordering by ${k}`);
      let dir = d as unknown;
      let nulls: 'first' | 'last' | undefined;
      if (typeof dir === 'object' && dir !== null) {
        const o2 = dir as { sort?: unknown; nulls?: unknown };
        if (Object.keys(o2).some((x) => x !== 'sort' && x !== 'nulls') || (o2.nulls !== undefined && o2.nulls !== 'first' && o2.nulls !== 'last')) no('ordering option');
        dir = o2.sort;
        nulls = o2.nulls as typeof nulls;
      }
      if (dir !== 'asc' && dir !== 'desc') no('ordering direction');
      out.push([k, dir === 'asc' ? 1 : -1, nulls]);
    }
  }
  return out;
}

/**
 * Sorts as PostgreSQL does: NULLs last going up, first going down (MongoDB puts them first
 * going up), ties in insertion order as a heap scan mostly gives.
 */
function sortStages(info: MirrorInfo, order: Order[]): Doc[] {
  if (!order.length) return [];
  const m = MODELS.get(info.model)!;
  const add: Doc = {};
  const sort: Doc = {};
  order.forEach(([k, dir, nulls], i) => {
    const f = m.fields.find((x) => x.name === k)!;
    if (!f.isRequired) {
      add[`__n${i}`] = { $eq: [{ $ifNull: [`$${k === 'id' ? '_id' : k}`, null] }, null] };
      // true (a NULL) sorts after false: up puts NULLs last, down first, unless asked otherwise.
      sort[`__n${i}`] = nulls ? (nulls === 'last' ? 1 : -1) : dir;
    }
    if (f.kind === 'enum') {
      // PostgreSQL orders an enum by the order its values were declared in, not by name.
      add[`__e${i}`] = { $indexOfArray: [ENUM_VALUES.get(f.type) ?? [], `$${k}`] };
      sort[`__e${i}`] = dir;
    } else sort[k === 'id' ? (f.type === 'String' ? '_id' : 'idNumber') : k] = dir;
  });
  return [...(Object.keys(add).length ? [{ $addFields: add }] : []), { $sort: sort }];
}

// ------------------------------------------------------------------ reading

/**
 * The row-level security policies that are wider or narrower than "this organisation"
 * (docs/SECURITY.md › Row-level security), as filters. `cross` policies see past the current
 * organisation, so they run as the system with the filter as the only limit.
 */
const POLICIES: Record<string, { cross: boolean; filter: (store: Store, ctx: { orgId?: string; userId?: string }) => Promise<Doc> }> = {
  // Your own memberships in every organisation, and everyone's inside the current one.
  Membership: { cross: true, filter: async (_s, c) => ({ $or: [...(c.orgId ? [{ orgId: c.orgId }] : []), ...(c.userId ? [{ userId: c.userId }] : []), { _id: { $exists: false } }] }) },
  // The current organisation and every organisation you belong to.
  Organization: { cross: true, filter: async (s, c) => ({ _id: { $in: [...(c.orgId ? [c.orgId] : []), ...(await myOrgs(s, c.userId))] } }) },
  Subscription: { cross: true, filter: async (s, c) => ({ orgId: { $in: [...(c.orgId ? [c.orgId] : []), ...(await myOrgs(s, c.userId))] } }) },
  // A copilot conversation is its member's alone, even inside the organisation.
  CopilotConversation: { cross: false, filter: async (_s, c) => ({ userId: c.userId ?? null }) },
  CopilotMessage: {
    cross: false,
    filter: async (s, c) => {
      const conv = modelInfo('CopilotConversation')!;
      const mine = await read(s, conv, { userId: c.userId ?? null }, { projection: { _id: 1 } });
      return { conversationId: { $in: mine.map((m) => m.id) } };
    },
  },
  // Benchmark contributions are pooled across organisations and read only by system work.
  BenchmarkContribution: { cross: false, filter: async () => ({ _id: { $exists: false } }) },
  // Shared tables whose organisation is optional: a tenant sees its own rows, rows of no organisation only system work.
  AuditEvent: { cross: false, filter: async (_s, c) => ownRows(c) },
  ErrorEvent: { cross: false, filter: async (_s, c) => ownRows(c) },
};

const ownRows = (c: { orgId?: string }): Doc => (c.orgId ? { orgId: c.orgId } : { _id: { $exists: false } });

async function myOrgs(store: Store, userId: string | undefined): Promise<string[]> {
  if (!userId) return [];
  const m = modelInfo('Membership');
  if (!m) return [];
  const rows = (await runAsSystem(() => store.collection(m.def).find({ userId }, { projection: { orgId: 1 } }))) as Doc[];
  return rows.map((r) => String(r.orgId));
}

/** Runs a filter against the collection the way RLS would see it: the request's organisation, or all for system work. */
async function read(store: Store, info: MirrorInfo, filter: Doc, opts: { order?: Order[]; skip?: number; take?: number; projection?: Doc } = {}): Promise<Doc[]> {
  const ctx = currentTenantContext();
  const policy = ctx.bypass ? undefined : POLICIES[info.model];
  if (policy) {
    const extra = await policy.filter(store, ctx);
    const narrowed = { $and: [filter, extra] };
    if (policy.cross) return runAsSystem(() => read(store, info, narrowed, opts));
    filter = narrowed;
  }
  // With no organisation set, row-level security shows no rows of a tenant table.
  if (info.tenant && !ctx.orgId && !ctx.bypass) return [];
  const e = info.embedded;
  const coll = store.collection(e ? e.parent : info.def);
  const pipeline: Doc[] = [];
  if (e) {
    // Lines live inside their parent: narrow to the parents first when the filter names them.
    const parent = filter[e.parentKey];
    if (parent !== undefined) pipeline.push({ $match: { _id: parent } });
    pipeline.push(
      { $unwind: `$${e.path}` },
      { $replaceRoot: { newRoot: { $mergeObjects: [`$${e.path}`, { [e.parentKey]: '$_id', orgId: '$orgId' }] } } },
      { $addFields: { _id: '$id' } },
    );
  }
  pipeline.push({ $match: mapId(filter) }, ...sortStages(info, opts.order ?? []));
  if (opts.skip) pipeline.push({ $skip: opts.skip });
  if (opts.take !== undefined) pipeline.push({ $limit: opts.take });
  if (opts.projection) pipeline.push({ $project: { ...mapId(opts.projection), ...(info.tenant ? { orgId: 1 } : {}) } });
  const rows = (await coll.aggregate<Doc>(pipeline)) as Doc[];
  return rows.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
}

/** `id` is stored as `_id`. */
function mapId(d: Doc): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === '$and' || k === '$or' || k === '$nor') out[k] = (v as Doc[]).map(mapId);
    else out[k === 'id' ? '_id' : k] = v;
  }
  return out;
}

/** A stored document as Prisma returns the row. */
function toRow(info: MirrorInfo, d: Doc): Doc {
  const out: Doc = {};
  for (const f of info.scalars) {
    let v = d[f.name];
    if (v === undefined) v = null;
    else if (f.name === 'id' && f.type !== 'String' && v !== null) v = f.type === 'BigInt' ? BigInt(String(v)) : Number(v);
    else if (v !== null) {
      if (f.type === 'Decimal') v = f.isList ? (v as string[]).map((x) => new Prisma.Decimal(x)) : new Prisma.Decimal(v as string);
      else if (f.type === 'BigInt') v = BigInt(v instanceof Long ? v.toString() : (v as number));
      else if (f.type === 'Bytes') v = v instanceof Binary ? new Uint8Array(v.buffer) : v;
      else if (f.type === 'Int' && v instanceof Long) v = v.toNumber();
    }
    out[f.name] = v;
  }
  return out;
}

interface ReadArgs {
  where?: unknown;
  orderBy?: unknown;
  skip?: number;
  take?: number;
  select?: Doc;
  include?: Doc;
  distinct?: unknown;
  cursor?: unknown;
  relationLoadStrategy?: unknown;
}

async function findRows(store: Store, info: MirrorInfo, args: ReadArgs = {}): Promise<Doc[]> {
  if (args.cursor) no('cursor');
  if (args.select && args.include) no('select with include');
  if (args.take !== undefined && args.take < 0) no('negative take');
  const filter = await toFilter(store, info, args.where);
  let rows: Doc[];
  if (args.distinct) {
    // As Prisma does it: the first row (in the order asked for) of each combination, then paging.
    const on = (Array.isArray(args.distinct) ? args.distinct : [args.distinct]) as string[];
    if (on.some((k) => !info.scalars.some((f) => f.name === k))) no('distinct on an unknown field');
    const seen = new Set<string>();
    rows = (await read(store, info, filter, { order: orderOf(info, args.orderBy) }))
      .map((d) => toRow(info, d))
      .filter((r) => {
        const key = JSON.stringify(on.map((k) => (r[k] === null ? null : String(r[k]))));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    rows = rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
  } else {
    const order = orderOf(info, args.orderBy);
    if (order.some(([k]) => k.includes('.'))) {
      rows = (await read(store, info, filter)).map((d) => toRow(info, d));
      rows = (await sortByRelations(store, info, rows, order)).slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
    } else rows = (await read(store, info, filter, { order, skip: args.skip, take: args.take })).map((d) => toRow(info, d));
  }
  await loadRelations(store, info, rows, args.select ?? args.include ?? {}, !!args.select);
  return args.select ? rows.map((r) => pick(info, r, args.select!)) : rows;
}

/** Fills in the relations an include or select asks for, a query per relation. */
async function loadRelations(store: Store, info: MirrorInfo, rows: Doc[], spec: Doc, isSelect: boolean) {
  const m = MODELS.get(info.model)!;
  for (const [k, want] of Object.entries(spec)) {
    if (!want) continue;
    if (k === '_count') {
      await loadCounts(store, info, rows, want);
      continue;
    }
    const f = m.fields.find((x) => x.name === k);
    if (!f) no(`unknown field ${k}`);
    if (f!.kind !== 'object') {
      if (!isSelect) no(`include of scalar ${k}`);
      continue;
    }
    const link = linkOf(info, f!);
    const nested: ReadArgs = want === true ? {} : (want as ReadArgs);
    const linked = (r: Doc) => link.local.every((x) => r[x] !== null && r[x] !== undefined);
    const own = (r: Doc): Doc => Object.fromEntries(link.remote.map((x, i) => [x, r[link.local[i]]]));
    if (link.many && (nested.take !== undefined || nested.skip)) {
      // Paging applies per parent, so each parent gets its own query.
      for (const r of rows) r[k] = linked(r) ? await findRows(store, link.target, { ...nested, where: { AND: [nested.where ?? {}, own(r)] } }) : [];
      continue;
    }
    const parents = rows.filter(linked);
    const keys = link.remote.map((x, i) => ({ [x]: { in: [...new Set(parents.map((r) => r[link.local[i]]))] } }));
    const extra = nested.select ? Object.fromEntries(link.remote.filter((x) => !nested.select![x]).map((x) => [x, true])) : {};
    const related = parents.length ? await findRows(store, link.target, { ...nested, where: { AND: [nested.where ?? {}, ...keys] }, select: nested.select ? { ...nested.select, ...extra } : undefined }) : [];
    const same = (x: Doc, r: Doc) => link.remote.every((y, i) => String(x[y]) === String(r[link.local[i]]));
    for (const r of rows) {
      const mine = linked(r) ? related.filter((x) => same(x, r)) : [];
      const shaped = Object.keys(extra).length ? mine.map((x) => Object.fromEntries(Object.entries(x).filter(([y]) => !(y in extra)))) : mine;
      r[k] = link.many ? shaped : (shaped[0] ?? null);
    }
  }
}

/**
 * Orders rows by fields of their to-one relations (and their own fields), as PostgreSQL would:
 * NULLs last going up and first going down unless asked, a missing relation as NULL.
 */
async function sortByRelations(store: Store, info: MirrorInfo, rows: Doc[], order: Order[]): Promise<Doc[]> {
  const rels = [...new Set(order.filter(([k]) => k.includes('.')).map(([k]) => k.split('.')[0]))];
  if (order.some(([k]) => k.split('.').length > 2)) no('ordering by a relation of a relation');
  const holder = rows.map((r) => ({ ...r }));
  await loadRelations(store, info, holder, Object.fromEntries(rels.map((r) => [r, true])), false);
  const value = (r: Doc, k: string): unknown => {
    const [a, b] = k.split('.');
    return b === undefined ? r[a] : ((r[a] as Doc | null)?.[b] ?? null);
  };
  const cmp = (x: unknown, y: unknown): number => {
    if (Prisma.Decimal.isDecimal(x)) return (x as Prisma.Decimal).cmp(y as Prisma.Decimal);
    if (x instanceof Date) return x.getTime() - (y as Date).getTime();
    return (x as string) < (y as string) ? -1 : (x as string) > (y as string) ? 1 : 0;
  };
  const idx = holder.map((_, i) => i);
  idx.sort((i, j) => {
    for (const [k, dir, nulls] of order) {
      const a = value(holder[i], k);
      const b = value(holder[j], k);
      const an = a === null || a === undefined;
      const bn = b === null || b === undefined;
      if (an || bn) {
        if (an && bn) continue;
        const nullsLast = nulls ? nulls === 'last' : dir === 1;
        return an === nullsLast ? 1 : -1;
      }
      const c = cmp(a, b);
      if (c) return c * dir;
    }
    return i - j;
  });
  return idx.map((i) => rows[i]);
}

/** `_count: true` or `_count: { select: { relation: true | { where } } }`: the related rows of each list relation, counted. */
async function loadCounts(store: Store, info: MirrorInfo, rows: Doc[], want: unknown) {
  const m = MODELS.get(info.model)!;
  const lists = m.fields.filter((f) => f.kind === 'object' && f.isList);
  let spec: Doc;
  if (want === true) spec = Object.fromEntries(lists.map((f) => [f.name, true]));
  else {
    const w = want as Doc;
    if (Object.keys(w).some((x) => x !== 'select') || typeof w.select !== 'object') no('_count option');
    spec = w.select as Doc;
  }
  for (const r of rows) r._count = {};
  for (const [name, c] of Object.entries(spec)) {
    if (!c) continue;
    const f = lists.find((x) => x.name === name);
    if (!f) no(`_count of ${name}`);
    const link = linkOf(info, f!);
    const where = c === true ? {} : (c as Doc).where ?? {};
    if (c !== true && Object.keys(c as Doc).some((x) => x !== 'where')) no('_count option');
    const parents = rows.filter((r) => link.local.every((x) => r[x] !== null && r[x] !== undefined));
    const keys = link.remote.map((x, i) => ({ [x]: { in: [...new Set(parents.map((r) => r[link.local[i]]))] } }));
    const related = parents.length ? await findRows(store, link.target, { where: { AND: [where, ...keys] }, select: Object.fromEntries(link.remote.map((x) => [x, true])) }) : [];
    for (const r of rows) (r._count as Doc)[name] = related.filter((x) => link.remote.every((y, i) => String(x[y]) === String(r[link.local[i]]))).length;
  }
}

function pick(info: MirrorInfo, row: Doc, select: Doc): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

// ------------------------------------------------------------------ groupBy and aggregate

const AGGS = ['_count', '_sum', '_avg', '_min', '_max'] as const;

/** Sums, averages, minimums and maximums of `rows` as Prisma returns them for each field type. */
function aggregateRows(info: MirrorInfo, rows: Doc[], spec: Doc): Doc {
  const out: Doc = {};
  const field = (n: string) => info.scalars.find((f) => f.name === n) ?? no(`aggregate of ${n}`);
  for (const agg of AGGS) {
    const want = spec[agg];
    if (!want) continue;
    if (agg === '_count') {
      if (want === true) {
        out._count = rows.length;
        continue;
      }
      const c: Doc = {};
      for (const [k, v] of Object.entries(want as Doc)) if (v) c[k] = k === '_all' ? rows.length : rows.filter((r) => r[field(k).name] !== null).length;
      out._count = c;
      continue;
    }
    const res: Doc = {};
    for (const [k, v] of Object.entries(want as Doc)) {
      if (!v) continue;
      const f = field(k);
      const vals = rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined);
      if (f.type !== 'Decimal' && f.type !== 'Int' && f.type !== 'Float' && f.type !== 'BigInt' && (agg === '_sum' || agg === '_avg')) no(`${agg} of ${f.type}`);
      if (!vals.length) {
        res[k] = null;
        continue;
      }
      if (agg === '_min' || agg === '_max') {
        const cmp = (a: unknown, b: unknown) => (Prisma.Decimal.isDecimal(a) ? (a as Prisma.Decimal).cmp(b as Prisma.Decimal) : a instanceof Date ? a.getTime() - (b as Date).getTime() : a! < b! ? -1 : a! > b! ? 1 : 0);
        res[k] = vals.reduce((m, x) => ((agg === '_min' ? cmp(x, m) < 0 : cmp(x, m) > 0) ? x : m));
        continue;
      }
      if (f.type === 'Decimal') {
        const sum = vals.reduce((t: Prisma.Decimal, x) => t.plus(x as Prisma.Decimal), new Prisma.Decimal(0));
        res[k] = agg === '_sum' ? sum : sum.div(vals.length);
      } else if (f.type === 'BigInt') {
        const sum = vals.reduce((t: bigint, x) => t + (x as bigint), 0n);
        res[k] = agg === '_sum' ? sum : Number(sum) / vals.length;
      } else {
        const sum = vals.reduce((t: number, x) => t + (x as number), 0);
        res[k] = agg === '_sum' ? sum : sum / vals.length;
      }
    }
    out[agg] = res;
  }
  return out;
}

async function groupRows(store: Store, info: MirrorInfo, args: Doc): Promise<Doc[]> {
  if (args.having) no('groupBy having');
  const by = (Array.isArray(args.by) ? args.by : [args.by]) as string[];
  if (by.some((k) => !info.scalars.some((f) => f.name === k))) no('groupBy on an unknown field');
  const filter = await toFilter(store, info, args.where);
  const rows = (await read(store, info, filter)).map((d) => toRow(info, d));
  const groups = new Map<string, Doc[]>();
  const keyOf = (r: Doc) => JSON.stringify(by.map((k) => (r[k] === null ? null : r[k] instanceof Date ? (r[k] as Date).toISOString() : String(r[k]))));
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let out = [...groups.values()].map((g) => ({ ...Object.fromEntries(by.map((k) => [k, g[0][k]])), ...aggregateRows(info, g, args) }));
  if (args.orderBy) {
    const list = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Doc[];
    const keys: { get: (r: Doc) => unknown; dir: 1 | -1 }[] = [];
    for (const o of list)
      for (const [k, d] of Object.entries(o)) {
        if ((AGGS as readonly string[]).includes(k)) {
          for (const [f, dd] of Object.entries(d as Doc)) keys.push({ get: (r) => (k === '_count' && typeof r._count === 'number' ? r._count : (r[k] as Doc)?.[f]), dir: dd === 'desc' ? -1 : 1 });
        } else if (by.includes(k) && (d === 'asc' || d === 'desc')) keys.push({ get: (r) => r[k], dir: d === 'desc' ? -1 : 1 });
        else no('groupBy ordering');
      }
    const cmp = (a: unknown, b: unknown): number => {
      const an = a === null || a === undefined;
      const bn = b === null || b === undefined;
      if (an || bn) return an && bn ? 0 : an ? 1 : -1;
      if (Prisma.Decimal.isDecimal(a)) return (a as Prisma.Decimal).cmp(b as Prisma.Decimal);
      if (a instanceof Date) return a.getTime() - (b as Date).getTime();
      return a! < b! ? -1 : a! > b! ? 1 : 0;
    };
    out = out.sort((x, y) => {
      for (const k of keys) {
        const a = k.get(x);
        const b = k.get(y);
        const nulls = (a === null || a === undefined) !== (b === null || b === undefined);
        // PostgreSQL: NULLs last going up, first going down.
        const c = nulls ? cmp(a, b) : cmp(a, b) * k.dir;
        if (c) return nulls && k.dir === -1 ? -c : c;
      }
      return 0;
    });
  }
  const skip = (args.skip as number | undefined) ?? 0;
  return out.slice(skip, args.take === undefined ? undefined : skip + (args.take as number));
}

// ------------------------------------------------------------------ the delegate

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

export const notFound = (model: string, cause = 'No record was found for a query.') =>
  new Prisma.PrismaClientKnownRequestError(`No ${model} found`, { code: 'P2025', clientVersion: Prisma.prismaVersion.client, meta: { modelName: model, cause } });

/** Read operations of `info`'s model from MongoDB, falling back to `pg` for what cannot be translated yet. */
export function mongoReadOps(pg: Delegate, info: MirrorInfo, store: Store): Record<string, (args: Doc) => Promise<unknown>> {
  const attempt = async (op: string, args: Doc | undefined, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof Untranslatable)) throw e;
      // With PostgreSQL off there is nothing to fall back to.
      if (process.env.T2T_POSTGRES === 'off') throw new Error(`${info.model}.${op} cannot be read from MongoDB: ${e.message}`);
      const key = `${info.model}.${op}: ${e.message}`;
      if (!FALLBACKS.has(key)) noteFallback(key);
      FALLBACKS.set(key, (FALLBACKS.get(key) ?? 0) + 1);
      return pg[op](args);
    }
  };
  const first = (args: Doc = {}) => findRows(store, info, { ...(args as ReadArgs), take: 1 }).then((r) => r[0] ?? null);
  return {
    findMany: (args) => attempt('findMany', args, () => findRows(store, info, args as ReadArgs)),
    findFirst: (args) => attempt('findFirst', args, () => first(args)),
    findUnique: (args) => attempt('findUnique', args, () => first(args)),
    findFirstOrThrow: (args) =>
      attempt('findFirstOrThrow', args, async () => {
        const r = await first(args);
        if (!r) throw notFound(info.model);
        return r;
      }),
    findUniqueOrThrow: (args) =>
      attempt('findUniqueOrThrow', args, async () => {
        const r = await first(args);
        if (!r) throw notFound(info.model);
        return r;
      }),
    groupBy: (args) => attempt('groupBy', args, () => groupRows(store, info, args)),
    aggregate: (args) =>
      attempt('aggregate', args, async () => {
        if (args?.orderBy || args?.cursor || args?.skip || args?.take) no('aggregate with options');
        const filter = await toFilter(store, info, args?.where);
        const rows = (await read(store, info, filter)).map((d) => toRow(info, d));
        return aggregateRows(info, rows, args ?? {});
      }),
    count: (args) =>
      attempt('count', args, async () => {
        if (args?.select || args?.distinct || args?.cursor || args?.orderBy) no('count with options');
        const filter = await toFilter(store, info, args?.where);
        const rows = await read(store, info, filter, { skip: args?.skip as number | undefined, take: args?.take as number | undefined, projection: { _id: 1 } });
        return rows.length;
      }),
  };
}

// While moving, a run can list what still reads PostgreSQL (READ_FALLBACKS_FILE=path): each
// model, operation and reason is written once per process, when it first happens.
function noteFallback(key: string) {
  const file = process.env.READ_FALLBACKS_FILE;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (file) require('node:fs').appendFileSync(file, `${key}\n`);
}
