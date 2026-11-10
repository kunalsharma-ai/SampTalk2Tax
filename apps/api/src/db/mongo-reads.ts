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
    if (f.name === 'id' && f.type !== 'String') parts.push(scalarFilter({ ...f, type: 'String' } as Field, stringIds(cond)));
    else if (f.kind === 'scalar' || f.kind === 'enum') parts.push(scalarFilter(f, cond));
    else parts.push(await relationFilter(store, info, f, cond));
  }
  const clean = parts.filter((p) => Object.keys(p).length);
  if (!clean.length) return {};
  return clean.length === 1 ? clean[0] : { $and: clean };
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
  const pairs = (from: readonly string[], to: readonly string[]) => from.map((x, i) => [x, to[i]] as const).filter(([x]) => x !== 'orgId');
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

function orderOf(info: MirrorInfo, orderBy: unknown): [string, 1 | -1][] {
  if (!orderBy) return [];
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Doc[];
  const m = MODELS.get(info.model)!;
  const out: [string, 1 | -1][] = [];
  for (const o of list) {
    for (const [k, dir] of Object.entries(o)) {
      const f = m.fields.find((x) => x.name === k);
      if (!f || (f.kind !== 'scalar' && f.kind !== 'enum')) no(`ordering by ${k}`);
      if (dir !== 'asc' && dir !== 'desc') no('ordering with null placement');
      out.push([k, dir === 'asc' ? 1 : -1]);
    }
  }
  return out;
}

/**
 * Sorts as PostgreSQL does: NULLs last going up, first going down (MongoDB puts them first
 * going up), ties in insertion order as a heap scan mostly gives.
 */
function sortStages(info: MirrorInfo, order: [string, 1 | -1][]): Doc[] {
  if (!order.length) return [];
  const m = MODELS.get(info.model)!;
  const add: Doc = {};
  const sort: Doc = {};
  order.forEach(([k, dir], i) => {
    const f = m.fields.find((x) => x.name === k)!;
    if (!f.isRequired) {
      add[`__n${i}`] = { $eq: [{ $ifNull: [`$${k === 'id' ? '_id' : k}`, null] }, null] };
      sort[`__n${i}`] = dir;
    }
    if (f.kind === 'enum') {
      // PostgreSQL orders an enum by the order its values were declared in, not by name.
      add[`__e${i}`] = { $indexOfArray: [ENUM_VALUES.get(f.type) ?? [], `$${k}`] };
      sort[`__e${i}`] = dir;
    } else sort[k === 'id' ? '_id' : k] = dir;
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
};

async function myOrgs(store: Store, userId: string | undefined): Promise<string[]> {
  if (!userId) return [];
  const m = modelInfo('Membership');
  if (!m) return [];
  const rows = (await runAsSystem(() => store.collection(m.def).find({ userId }, { projection: { orgId: 1 } }))) as Doc[];
  return rows.map((r) => String(r.orgId));
}

/** Runs a filter against the collection the way RLS would see it: the request's organisation, or all for system work. */
async function read(store: Store, info: MirrorInfo, filter: Doc, opts: { order?: [string, 1 | -1][]; skip?: number; take?: number; projection?: Doc } = {}): Promise<Doc[]> {
  const ctx = currentTenantContext();
  const policy = ctx.bypass ? undefined : POLICIES[info.model];
  if (policy) {
    const extra = await policy.filter(store, ctx);
    const narrowed = { $and: [filter, extra] };
    if (policy.cross) return runAsSystem(() => read(store, info, narrowed, opts));
    filter = narrowed;
  }
  if (info.tenant && !ctx.orgId && !ctx.bypass) no('no organisation in context');
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
  if (args.distinct || args.cursor) no(args.distinct ? 'distinct' : 'cursor');
  if (args.select && args.include) no('select with include');
  if (args.take !== undefined && args.take < 0) no('negative take');
  const filter = await toFilter(store, info, args.where);
  const rows = (await read(store, info, filter, { order: orderOf(info, args.orderBy), skip: args.skip, take: args.take })).map((d) => toRow(info, d));
  await loadRelations(store, info, rows, args.select ?? args.include ?? {}, !!args.select);
  return args.select ? rows.map((r) => pick(info, r, args.select!)) : rows;
}

/** Fills in the relations an include or select asks for, a query per relation. */
async function loadRelations(store: Store, info: MirrorInfo, rows: Doc[], spec: Doc, isSelect: boolean) {
  const m = MODELS.get(info.model)!;
  for (const [k, want] of Object.entries(spec)) {
    if (!want) continue;
    if (k === '_count') no('_count');
    const f = m.fields.find((x) => x.name === k);
    if (!f) no(`unknown field ${k}`);
    if (f!.kind !== 'object') {
      if (!isSelect) no(`include of scalar ${k}`);
      continue;
    }
    const link = linkOf(info, f!);
    if (link.local.length !== 1) no('relation on a compound key');
    const nested: ReadArgs = want === true ? {} : (want as ReadArgs);
    const keys = [...new Set(rows.map((r) => r[link.local[0]]).filter((x) => x !== null && x !== undefined))];
    if (link.many && (nested.take !== undefined || nested.skip)) {
      // Paging applies per parent, so each parent gets its own query.
      for (const r of rows) {
        const w = { AND: [nested.where ?? {}, { [link.remote[0]]: r[link.local[0]] }] };
        r[k] = r[link.local[0]] === null ? [] : await findRows(store, link.target, { ...nested, where: w });
      }
      continue;
    }
    const related = keys.length ? await findRows(store, link.target, { ...nested, where: { AND: [nested.where ?? {}, { [link.remote[0]]: { in: keys } }] }, select: nested.select ? { ...nested.select, [link.remote[0]]: true } : undefined }) : [];
    const strip = nested.select && !nested.select[link.remote[0]];
    for (const r of rows) {
      const mine = related.filter((x) => x[link.remote[0]] === r[link.local[0]] && r[link.local[0]] !== null);
      const shaped = strip ? mine.map(({ [link.remote[0]]: _drop, ...rest }) => rest) : mine;
      r[k] = link.many ? shaped : (shaped[0] ?? null);
    }
  }
}

function pick(info: MirrorInfo, row: Doc, select: Doc): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

// ------------------------------------------------------------------ the delegate

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

const notFound = (model: string) =>
  new Prisma.PrismaClientKnownRequestError(`No ${model} found`, { code: 'P2025', clientVersion: Prisma.prismaVersion.client, meta: { modelName: model, cause: 'No record was found for a query.' } });

/** Read operations of `info`'s model from MongoDB, falling back to `pg` for what cannot be translated yet. */
export function mongoReadOps(pg: Delegate, info: MirrorInfo, store: Store): Record<string, (args: Doc) => Promise<unknown>> {
  const attempt = async (op: string, args: Doc | undefined, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof Untranslatable)) throw e;
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
    count: (args) =>
      attempt('count', args, async () => {
        if (args?.select || args?.distinct || args?.cursor || args?.orderBy) no('count with options');
        const filter = await toFilter(store, info, args?.where);
        const ctx = currentTenantContext();
        if (info.tenant && !ctx.orgId && !ctx.bypass) no('no organisation in context');
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
