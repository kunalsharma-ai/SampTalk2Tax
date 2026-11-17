import { randomUUID } from 'node:crypto';
import { Prisma } from '@talk2tax/database';

/**
 * Prisma's write arguments worked out as PostgreSQL would store them: the defaults of the
 * schema, the column types (numerics rounded to their scale, dates without their time, CHAR
 * padded, VARCHAR limits) and the update operators. The rows come back with Prisma's field names
 * and types, ready for the guards, the constraints and MongoDB. Nested creates
 * (`lines: { create: [...] }`) become rows of the child model with their keys filled in.
 *
 * While PostgreSQL still runs, every write is planned here as well and the plan is compared
 * with what PostgreSQL stored (mirror-writes.ts), so this is what MongoDB writes once
 * PostgreSQL is gone.
 */

type Row = Record<string, unknown>;
type Field = Prisma.DMMF.Field;
type Model = Prisma.DMMF.Model;

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

export interface PlannedRow {
  model: string;
  row: Row;
  /** The record as it stood (updates). */
  before: Row | null;
}

/** An error PostgreSQL would raise for the value (too long, numeric overflow). */
export class ValueError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const scalarsOf = (m: Model) => m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');

/** Next number of an autoincrement column; set by the caller that owns the sequences. */
let autoincrement: ((model: string, field: string) => Promise<number>) | undefined;

/** Stands in for a sequence's next value while PostgreSQL still draws it (the plan check). */
export const FROM_SEQUENCE = Number.MIN_SAFE_INTEGER;
export const hasAutoincrement = () => !!autoincrement;
export const fromSequence = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint') && Number(v) === FROM_SEQUENCE;
export function useAutoincrement(fn: (model: string, field: string) => Promise<number>) {
  autoincrement = fn;
}

async function defaultOf(m: Model, f: Field, now: Date): Promise<unknown> {
  const d = f.default as unknown;
  if (f.isUpdatedAt) return now;
  if (d === undefined) return undefined;
  if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
    const fn = d as { name: string; args?: unknown[] };
    if (fn.name === 'uuid' || fn.name === 'cuid' || (fn.name === 'dbgenerated' && /gen_random_uuid|uuid_generate/i.test(String(fn.args?.[0])))) return randomUUID();
    if (fn.name === 'now') return now;
    if (fn.name === 'autoincrement') {
      if (!autoincrement) throw new Error(`${m.name}.${f.name} needs a sequence`);
      return autoincrement(m.name, f.name);
    }
    throw new Error(`The default ${fn.name}() of ${m.name}.${f.name} is not supported`);
  }
  if (Array.isArray(d)) return [...d];
  if (f.type === 'Json' && typeof d === 'string') return JSON.parse(d);
  return d;
}

/** A value in the column's type, as PostgreSQL would store it. */
export function normalize(m: Model, f: Field, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || v === Prisma.DbNull) return null;
  if (f.isList) return (v as unknown[]).map((x) => normalize(m, { ...f, isList: false }, x));
  const native = f.nativeType as [string, string[]] | null | undefined;
  switch (f.type) {
    case 'Decimal': {
      let d = new Prisma.Decimal(Prisma.Decimal.isDecimal(v) ? (v as Prisma.Decimal) : String(v));
      if (native?.[0] === 'Decimal' && native[1].length === 2) {
        const [p, s] = native[1].map(Number);
        d = d.toDecimalPlaces(s, Prisma.Decimal.ROUND_HALF_UP);
        if (!d.isZero() && d.abs().gte(new Prisma.Decimal(10).pow(p - s))) throw new ValueError(`numeric field overflow: ${m.name}.${f.name} holds ${p - s} digits before the point`, '22003');
      }
      return d;
    }
    case 'DateTime': {
      const t = v instanceof Date ? new Date(v.getTime()) : new Date(String(v));
      if (Number.isNaN(t.getTime())) throw new ValueError(`invalid input syntax for type timestamp: "${String(v)}"`, '22007');
      return native?.[0] === 'Date' ? new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) : t;
    }
    case 'String': {
      let s = String(v);
      const n = native && (native[0] === 'VarChar' || native[0] === 'Char') && native[1][0] ? Number(native[1][0]) : undefined;
      if (n !== undefined && [...s].length > n) {
        // PostgreSQL drops trailing spaces that do not fit, and refuses anything else.
        if (/^ *$/.test([...s].slice(n).join(''))) s = [...s].slice(0, n).join('');
        else throw new ValueError(`value too long for type ${native![0] === 'Char' ? 'character' : 'character varying'}(${n})`, '22001');
      }
      if (native?.[0] === 'Char' && n !== undefined) s = s.padEnd(n, ' ');
      return s;
    }
    case 'Int':
    case 'Float':
      return typeof v === 'number' ? v : Number(v);
    case 'BigInt':
      return typeof v === 'bigint' ? v : BigInt(String(v));
    case 'Boolean':
      return Boolean(v);
    case 'Bytes':
      return v instanceof Uint8Array ? v : Buffer.from(v as string);
    case 'Json':
      // As jsonb keeps it: undefined members dropped, decimals and dates as their JSON text.
      return v === Prisma.JsonNull || v === Prisma.DbNull ? null : JSON.parse(JSON.stringify(v));
    default:
      return v; // enums
  }
}

const numericOp = (f: Field, cur: unknown, op: string, by: unknown) => {
  if (cur === null || cur === undefined) return null; // SQL: NULL + n is NULL
  if (f.type === 'Decimal') {
    const a = new Prisma.Decimal(String(cur));
    const b = new Prisma.Decimal(String(by));
    return op === 'increment' ? a.plus(b) : op === 'decrement' ? a.minus(b) : op === 'multiply' ? a.times(b) : a.div(b);
  }
  if (f.type === 'BigInt') {
    const a = BigInt(String(cur));
    const b = BigInt(String(by));
    return op === 'increment' ? a + b : op === 'decrement' ? a - b : op === 'multiply' ? a * b : a / b;
  }
  const a = Number(cur);
  const b = Number(by);
  const r = op === 'increment' ? a + b : op === 'decrement' ? a - b : op === 'multiply' ? a * b : a / b;
  return f.type === 'Int' ? Math.trunc(r) : r;
};

/** The value a scalar gets from an update's data entry (a value, or `{ set | increment | ... }`). */
function updatedValue(m: Model, f: Field, cur: unknown, entry: unknown): unknown {
  if (entry !== null && typeof entry === 'object' && !(entry instanceof Date) && !Prisma.Decimal.isDecimal(entry) && !Array.isArray(entry) && !(entry instanceof Uint8Array) && f.type !== 'Json') {
    const [op, arg] = Object.entries(entry as Row)[0] ?? [];
    if (op === 'set') return normalize(m, f, arg);
    if (op === 'push') return [...((cur as unknown[]) ?? []), ...(Array.isArray(arg) ? arg : [arg])].map((x) => normalize(m, { ...f, isList: false }, x));
    if (['increment', 'decrement', 'multiply', 'divide'].includes(op as string)) return normalize(m, f, numericOp(f, cur, op as string, arg));
    throw new Error(`The update operation ${String(op)} on ${m.name}.${f.name} is not supported`);
  }
  if (f.type === 'Json' && entry !== null && typeof entry === 'object' && 'set' in (entry as Row) && Object.keys(entry as Row).length === 1 && f.isList) return normalize(m, f, (entry as Row).set);
  return normalize(m, f, entry);
}

/** The relation's foreign key on the child side: which child fields take which parent fields. */
function childLink(m: Model, rel: Field) {
  const child = MODELS.get(rel.type)!;
  const back = child.fields.find((x) => x.kind === 'object' && x.relationName === rel.relationName && x !== rel && x.relationFromFields?.length);
  if (!back) throw new Error(`${m.name}.${rel.name}: only nested writes to child records are supported`);
  return { child, from: [...back.relationFromFields!], to: [...back.relationToFields!] };
}

/** The foreign key a `connect` on the parent side sets (`contact: { connect: { id } }`). */
function connectFields(rel: Field, arg: Row): Row {
  if (!rel.relationFromFields?.length) throw new Error(`connect on ${rel.name} is not supported`);
  const keys = Object.keys(arg);
  const out: Row = {};
  rel.relationFromFields.forEach((from, i) => {
    const to = rel.relationToFields![i];
    if (!(to in arg) && keys.length === 1 && typeof arg[keys[0]] === 'object') Object.assign(out, { [from]: (arg[keys[0]] as Row)[to] });
    else out[from] = arg[to];
  });
  return out;
}

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * A new record of `model` from create data, with its nested children after it. With `writeBack`,
 * generated keys are written into `data` (and its nested creates), so another database given the
 * same data stores the same keys.
 */
export async function planCreate(model: string, data: Row, now = new Date(), writeBack = false, keys: Row = {}): Promise<PlannedRow[]> {
  const m = MODELS.get(model)!;
  const row: Row = {};
  const nested: [Field, Row][] = [];
  for (const [k, v] of Object.entries({ ...data, ...keys })) {
    if (v === undefined) continue;
    const f = m.fields.find((x) => x.name === k);
    if (!f) throw new Error(`${model} has no field ${k}`);
    if (f.kind === 'object') {
      const ops = v as Row;
      if (ops.connect && !f.isList) Object.assign(row, connectFields(f, ops.connect as Row));
      else nested.push([f, ops]);
      for (const op of Object.keys(ops)) if (!['create', 'createMany', 'connect'].includes(op)) throw new Error(`Nested ${op} on create of ${model}.${k} is not supported`);
    } else row[k] = normalize(m, f, v);
  }
  for (const f of scalarsOf(m)) {
    if (row[f.name] !== undefined) continue;
    const d = await defaultOf(m, f, now);
    row[f.name] = d === undefined ? (f.isList ? [] : null) : normalize(m, f, d);
    if (writeBack && f.isId && d !== undefined && (f.default as { name?: string } | undefined)?.name === 'uuid') data[f.name] = row[f.name];
  }
  const out: PlannedRow[] = [{ model, row, before: null }];
  for (const [f, ops] of nested) out.push(...(await planChildren(m, f, row, ops, now, writeBack)));
  return out;
}

async function planChildren(m: Model, f: Field, parent: Row, ops: Row, now: Date, writeBack = false): Promise<PlannedRow[]> {
  const { child, from, to } = childLink(m, f);
  const keys = Object.fromEntries(from.map((x, i) => [x, parent[to[i]]]));
  const out: PlannedRow[] = [];
  const items = [...asList(ops.create as Row | Row[]), ...asList((ops.createMany as { data?: Row | Row[] } | undefined)?.data)];
  // A nested create names the child's other relations by key, not through this parent.
  for (const item of items) out.push(...(await planCreate(child.name, item, now, writeBack, keys)));
  return out;
}

/** The record after an update's data, and the children its nested creates add. */
export async function planUpdate(
  model: string,
  before: Row,
  data: Row,
  now = new Date(),
  writeBack = false,
): Promise<{ row: Row; children: PlannedRow[]; nestedDeletes: { model: string; where: Row }[] }> {
  const m = MODELS.get(model)!;
  const row: Row = { ...before };
  const children: PlannedRow[] = [];
  const nestedDeletes: { model: string; where: Row }[] = [];
  const later: [Field, Row][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const f = m.fields.find((x) => x.name === k);
    if (!f) throw new Error(`${model} has no field ${k}`);
    if (f.kind === 'object') later.push([f, v as Row]);
    else row[k] = updatedValue(m, f, before[k], v);
  }
  for (const f of scalarsOf(m)) if (f.isUpdatedAt && data[f.name] === undefined) row[f.name] = now;
  for (const [f, ops] of later) {
    if (ops.connect && !f.isList) {
      Object.assign(row, connectFields(f, ops.connect as Row));
      continue;
    }
    const { child, from, to } = childLink(m, f);
    const keys = Object.fromEntries(from.map((x, i) => [x, row[to[i]]]));
    for (const [op, arg] of Object.entries(ops)) {
      if (op === 'create' || op === 'createMany') children.push(...(await planChildren(m, f, row, { [op]: arg }, now, writeBack)));
      else if (op === 'deleteMany') for (const w of asList(arg as Row | Row[])) nestedDeletes.push({ model: child.name, where: { ...(w ?? {}), ...keys } });
      else throw new Error(`Nested ${op} on update of ${model}.${f.name} is not supported`);
    }
  }
  return { row, children, nestedDeletes };
}

// ------------------------------------------------------------------ comparing with PostgreSQL

const TOLERANCE_MS = 60_000;

const same = (f: Field, a: unknown, b: unknown): boolean => {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (f.isList) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same({ ...f, isList: false }, x, b[i]));
  if (f.type === 'Decimal') return new Prisma.Decimal(String(a)).eq(String(b)) && new Prisma.Decimal(String(a)).decimalPlaces() === new Prisma.Decimal(String(b)).decimalPlaces();
  if (f.type === 'DateTime') {
    const gap = Math.abs(+new Date(a as Date) - +new Date(b as Date));
    const generated = f.isUpdatedAt || (f.default as { name?: string } | undefined)?.name === 'now';
    return generated ? gap < TOLERANCE_MS : gap === 0;
  }
  if (f.type === 'Bytes') return Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array));
  if (f.type === 'Json') return canonical(a) === canonical(b);
  if (f.type === 'BigInt') return String(a) === String(b);
  return a === b;
};

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
};

/** A where on a compound unique key (orgId_kpi: { orgId, kpi }) as plain fields. */
export function flatWhere(model: string, where: Row): Row {
  const names = new Set(MODELS.get(model)!.fields.map((f) => f.name));
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (!names.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v) && !['AND', 'OR', 'NOT'].includes(k)) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

/** The fields where the planned record differs from what PostgreSQL stored. */
export function differences(model: string, planned: Row, stored: Row): string[] {
  const m = MODELS.get(model)!;
  const out: string[] = [];
  for (const f of scalarsOf(m)) {
    if (fromSequence(planned[f.name])) continue;
    if (!same(f, planned[f.name], stored[f.name])) out.push(`${model}.${f.name}: planned ${show(planned[f.name])}, stored ${show(stored[f.name])}`);
  }
  return out;
}

const show = (v: unknown) => {
  if (v === undefined) return 'undefined';
  if (Prisma.Decimal.isDecimal(v)) return `${(v as Prisma.Decimal).toFixed()}d`;
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  const s = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};
