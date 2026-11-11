import { randomUUID } from 'node:crypto';
import { Prisma } from '@talk2tax/database';
import { runAsSystem, runInOrg, tenantStorage } from '../src/common/tenant-context';
import { postgresOff } from '../src/db/counters';
import { parseCheck, valueOf, holds } from '../src/db/constraints/sql-expr';
import { modelInfo, mongoRows } from '../src/db/mirror-writes';
import { forMongo } from '../src/db/moved-table';
import type { Ctx } from './helpers';

/**
 * A test's direct write to a table, written as the SQL it would run against PostgreSQL:
 * `UPDATE t SET a = x, ... WHERE ...` or `DELETE FROM t WHERE ...`. Tests use these to check
 * that the database itself refuses a change the API never makes, or to set up a state (a date
 * moved back) the API can't reach.
 *
 * While PostgreSQL runs, the SQL runs there as before. With PostgreSQL off it runs against
 * MongoDB through the data layer: the matching records are found by evaluating the WHERE
 * clause, and each is changed or deleted the way the API would, so guards, checks and
 * references apply. `bypass` runs it as the system (row-level security off).
 */
export async function sqlWrite(ctx: Ctx, sql: string, args: unknown[] = [], opts: { bypass?: boolean } = {}): Promise<number> {
  if (!postgresOff()) {
    if (!opts.bypass) return ctx.prisma.$executeRawUnsafe(sql, ...args);
    return ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      return tx.$executeRawUnsafe(sql, ...args);
    });
  }
  // Guards are switched off with allowInTx('guards_off') around the write; PostgreSQL's trigger switches have no part.
  if (/^ALTER\s+TABLE\s+\w+\s+(DISABLE|ENABLE)\s+TRIGGER\s+\w+$/i.test(sql.trim())) return 0;
  const text = (await subqueries(ctx, bind(sql.trim().replace(/;$/, ''), args)))
    .replace(/\bCURRENT_DATE\b/gi, `DATE '${new Date().toISOString().slice(0, 10)}'`)
    .replace(/repeat\('([^']*)', (\d+)\)/gi, (_m, x: string, n: string) => `'${x.repeat(Number(n))}'`);
  const ins = /^INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*(?:VALUES\s*\(([\s\S]+)\)|SELECT\s+([\s\S]+?)\s+FROM\s+(\w+(?:\([^)]*\))?)(?:\s+(\w+))?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+))?)$/i.exec(text);
  if (ins) {
    const t = tableOf(ins[1]);
    const columns = ins[2].split(',').map((c) => c.trim().replace(/"/g, ''));
    const values = splitTop(ins[3] ?? ins[4]);
    if (values.length !== columns.length) throw new Error(`sqlWrite: ${columns.length} columns and ${values.length} values`);
    // VALUES is one record; INSERT ... SELECT one for each source record (a table, or generate_series).
    let sources: Record<string, unknown>[] = [{}];
    if (ins[4]) {
      const series = /^generate_series\((\d+)(?:::\w+)?,\s*(\d+)(?:::\w+)?\)$/i.exec(ins[5]);
      if (series) sources = Array.from({ length: Number(series[2]) - Number(series[1]) + 1 }, (_x, i) => ({ [ins[6] ?? 'generate_series']: new Prisma.Decimal(Number(series[1]) + i) }));
      else sources = (await matching(ctx, tableOf(ins[5]), ins[7] && unalias(ins[7], ins[6]))).map((r) => r.columns);
      if (ins[8]) sources = sources.slice(0, Number(ins[8]));
    }
    const exprs = values.map((v) => parseCheck(ins[4] ? unalias(v, ins[6]) : v));
    for (const src of sources) {
      const data: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        const f = t.fields.find((x) => x.column === c);
        if (!f) throw new Error(`${t.table} has no column ${c}`);
        data[f.name] = toField(f.field, valueOf(exprs[i], src));
      });
      await insert(ctx, t, data);
    }
    return sources.length;
  }
  const upd = /^UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(text);
  const del = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(text);
  if (!upd && !del) throw new Error(`sqlWrite handles INSERT, UPDATE and DELETE only: ${sql}`);
  const table = (upd ?? del)![1];
  const where = upd ? upd[3] : del![2];
  const sets = upd ? splitTop(upd[2]).map((a) => {
    const m = /^"?(\w+)"?\s*=\s*([\s\S]+)$/.exec(a.trim());
    if (!m) throw new Error(`sqlWrite can't read the assignment ${a}`);
    return { column: m[1], expr: parseCheck(m[2]) };
  }) : [];
  const t = tableOf(table);
  const rows = await matching(ctx, t, where);
  for (const r of rows) {
    if (upd) {
      const data: Record<string, unknown> = {};
      for (const s of sets) {
        const f = t.fields.find((x) => x.column === s.column);
        if (!f) throw new Error(`${table} has no column ${s.column}`);
        data[f.name] = toField(f.field, valueOf(s.expr, r.columns));
      }
      await change(ctx, t, r.row, data);
    } else await remove(ctx, t, r.row);
  }
  return rows.length;
}

/** `alias.column` as plain `column` (one source table). */
const unalias = (sql: string, alias: string | undefined) => (alias ? sql.replace(new RegExp(`\\b${alias}\\.`, 'g'), '') : sql);

/**
 * `(SELECT column FROM table WHERE ... [LIMIT n])` replaced by what it finds: a list after IN,
 * otherwise the first value (or NULL).
 */
async function subqueries(ctx: Ctx, sql: string): Promise<string> {
  const re = /(\bIN\s*)?\(\s*SELECT\s+(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+([^()]*?))?(?:\s+LIMIT\s+(\d+))?\s*\)/i;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    let rows = (await matching(ctx, tableOf(m[3]), m[4])).map((r) => r.columns[m![2]]);
    if (m[5]) rows = rows.slice(0, Number(m[5]));
    const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : v instanceof Date ? `'${v.toISOString()}'` : `'${String(v).replace(/'/g, "''")}'`);
    const out = m[1] ? `${m[1]}(${rows.length ? rows.map(lit).join(', ') : 'NULL'})` : lit(rows[0]);
    sql = sql.slice(0, m.index) + out + sql.slice(m.index + m[0].length);
  }
  return sql;
}

type Field = Prisma.DMMF.Field;
interface TableMeta {
  table: string;
  model: string;
  delegate: string;
  fields: { name: string; column: string; field: Field }[];
  info: NonNullable<ReturnType<typeof modelInfo>>;
}

function tableOf(table: string): TableMeta {
  const m = Prisma.dmmf.datamodel.models.find((x) => (x.dbName ?? x.name) === table);
  if (!m) throw new Error(`No model for table ${table}`);
  const info = modelInfo(m.name);
  if (!info) throw new Error(`${table} is not held in MongoDB`);
  const fields = m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => ({ name: f.name, column: f.dbName ?? f.name, field: f }));
  return { table, model: m.name, delegate: m.name[0].toLowerCase() + m.name.slice(1), fields, info };
}

/** The records the WHERE clause holds for, as Prisma gives them and by column name. */
async function matching(ctx: Ctx, t: TableMeta, where: string | undefined) {
  const cond = where ? parseCheck(where) : null;
  // Plain `column = 'value'` parts narrow the read; the whole clause is then evaluated on each record.
  const narrow: Record<string, unknown> = {};
  for (const [column, v] of equalities(cond)) {
    const f = t.fields.find((x) => x.column === column);
    if (f && typeof v === 'string' && (f.field.type === 'String' || f.field.kind === 'enum')) narrow[f.name] = v;
  }
  const rows = await mongoRows(ctx.store as never, t.delegate, narrow);
  return rows
    .map((row) => ({ row, columns: Object.fromEntries(t.fields.map((f) => [f.column, fromField(f.field, row[f.name])])) }))
    .filter((r) => !cond || holds(cond, r.columns));
}

async function change(ctx: Ctx, t: TableMeta, row: Record<string, unknown>, data: Record<string, unknown>) {
  if (!t.info.readOnly) {
    const key = whereOf(t, row);
    await tenantStorage.run({ bypass: true } as never, async () => await (ctx.prisma as unknown as Record<string, { update(a: unknown): Promise<unknown> }>)[t.delegate].update({ where: key, data }));
    return;
  }
  const orgId = String(row.orgId);
  const e = t.info.embedded;
  if (!e) {
    await runInOrg(orgId, () => ctx.store.collection(t.info.def).updateOne({ id: row.id } as never, { $set: forMongo(data) } as never));
    return;
  }
  // A line kept inside its parent: the parent is written with the line changed.
  const parentId = row[e.parentKey] as string;
  const parent = (await runAsSystem(() => ctx.store.collection(e.parent).findOne({ id: parentId } as never))) as Record<string, unknown>;
  const lines = (parent[e.path] as Record<string, unknown>[]).map((l) => (l.id === row.id ? { ...l, ...data } : l));
  await runInOrg(orgId, () => ctx.store.collection(e.parent).updateOne({ id: parentId } as never, { $set: forMongo({ [e.path]: lines }) } as never));
}

async function insert(ctx: Ctx, t: TableMeta, data: Record<string, unknown>) {
  if (!t.info.readOnly) {
    await tenantStorage.run({ bypass: true } as never, async () => await (ctx.prisma as unknown as Record<string, { create(a: unknown): Promise<unknown> }>)[t.delegate].create({ data }));
    return;
  }
  // A table moved by hand: the record with the columns' defaults, written to its collection.
  const row: Record<string, unknown> = {};
  for (const f of t.fields) row[f.name] = f.name in data ? data[f.name] : defaultOf(f.field);
  const orgId = String(row.orgId);
  delete row.orgId;
  const e = t.info.embedded;
  if (!e) {
    await runInOrg(orgId, () => ctx.store.collection(t.info.def).insertOne(forMongo(row) as never));
    return;
  }
  const parentId = row[e.parentKey] as string;
  delete row[e.parentKey];
  const parent = (await runAsSystem(() => ctx.store.collection(e.parent).findOne({ id: parentId } as never))) as Record<string, unknown> | null;
  if (!parent) throw new Error(`No ${e.parent.name} ${parentId}`);
  const lines = [...(parent[e.path] as Record<string, unknown>[]), row];
  await runInOrg(orgId, () => ctx.store.collection(e.parent).updateOne({ id: parentId } as never, { $set: forMongo({ [e.path]: lines }) } as never));
}

/** A column's default when an INSERT leaves it out. */
function defaultOf(f: Field): unknown {
  if (f.isUpdatedAt) return new Date();
  const d = f.default as unknown;
  if (d === undefined) return f.isList ? [] : null;
  if (d !== null && typeof d === 'object' && 'name' in (d as object)) {
    const name = (d as { name: string }).name;
    if (name === 'now') return new Date();
    if (name === 'uuid' || name === 'dbgenerated') return f.type === 'String' ? randomUUID() : null;
    return null;
  }
  if (f.type === 'Decimal') return new Prisma.Decimal(String(d));
  if (f.type === 'Json' && typeof d === 'string') return JSON.parse(d);
  return d;
}

async function remove(ctx: Ctx, t: TableMeta, row: Record<string, unknown>) {
  if (!t.info.readOnly) {
    await tenantStorage.run({ bypass: true } as never, async () => await (ctx.prisma as unknown as Record<string, { delete(a: unknown): Promise<unknown> }>)[t.delegate].delete({ where: whereOf(t, row) }));
    return;
  }
  const orgId = String(row.orgId);
  const e = t.info.embedded;
  if (!e) {
    await runInOrg(orgId, () => ctx.store.collection(t.info.def).deleteOne({ id: row.id } as never));
    return;
  }
  const parentId = row[e.parentKey] as string;
  const parent = (await runAsSystem(() => ctx.store.collection(e.parent).findOne({ id: parentId } as never))) as Record<string, unknown>;
  const lines = (parent[e.path] as Record<string, unknown>[]).filter((l) => l.id !== row.id);
  await runInOrg(orgId, () => ctx.store.collection(e.parent).updateOne({ id: parentId } as never, { $set: forMongo({ [e.path]: lines }) } as never));
}

/** The record's primary key as a Prisma where (compound keys by their joined name). */
function whereOf(t: TableMeta, row: Record<string, unknown>) {
  const pk = t.info.pk;
  if (pk.length === 1) return { [pk[0]]: row[pk[0]] };
  return { [pk.join('_')]: Object.fromEntries(pk.map((k) => [k, row[k]])) };
}

/** `$1`, `$2`, ... replaced by SQL literals. */
function bind(sql: string, args: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n) => literal(args[Number(n) - 1]));
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/** Splits on commas outside brackets and quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of s) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && (ch === '(' || ch === '[')) depth++;
    if (!quoted && (ch === ')' || ch === ']')) depth--;
    if (ch === ',' && !quoted && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

type Node = ReturnType<typeof parseCheck>;
/** The `column = literal` parts of a WHERE clause joined by AND. */
function equalities(n: Node | null): [string, unknown][] {
  if (!n) return [];
  const x = n as unknown as { k: string; op?: string; a?: Node; b?: Node; name?: string; v?: unknown };
  if (x.k === 'bin' && String(x.op).toUpperCase() === 'AND') return [...equalities(x.a!), ...equalities(x.b!)];
  if (x.k !== 'bin' || x.op !== '=') return [];
  const side = (y: Node): { col?: string; lit?: unknown } => {
    let z = y as unknown as { k: string; a?: Node; name?: string; v?: unknown };
    while (z.k === 'cast') z = z.a as never;
    return z.k === 'col' ? { col: z.name } : z.k === 'lit' ? { lit: z.v } : {};
  };
  const a = side(x.a!);
  const b = side(x.b!);
  if (a.col && 'lit' in b) return [[a.col, b.lit]];
  if (b.col && 'lit' in a) return [[b.col, a.lit]];
  return [];
}

/** A Prisma value as the SQL expressions see it (numbers as decimals). */
function fromField(f: Field, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (f.type === 'Int' || f.type === 'BigInt' || f.type === 'Float') return Array.isArray(v) ? v : new Prisma.Decimal(String(v));
  return v;
}

/** An evaluated SQL value as the Prisma field takes it. */
function toField(f: Field, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const dec = Prisma.Decimal.isDecimal(v);
  switch (f.type) {
    case 'Int':
    case 'Float':
      return dec ? (v as Prisma.Decimal).toNumber() : Number(v);
    case 'BigInt':
      return BigInt(dec ? (v as Prisma.Decimal).toFixed(0) : String(v));
    case 'Decimal':
      return dec ? v : new Prisma.Decimal(String(v));
    case 'DateTime':
      return v instanceof Date ? v : new Date(String(v));
    case 'Boolean':
      return typeof v === 'string' ? ['t', 'true'].includes(v.toLowerCase()) : !!v;
    case 'Bytes':
      return typeof v === 'string' ? Buffer.from(v) : v;
    case 'Json':
      return typeof v === 'string' ? JSON.parse(v) : v;
    default:
      return dec ? (v as Prisma.Decimal).toString() : v;
  }
}
