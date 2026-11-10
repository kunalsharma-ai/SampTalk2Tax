import { Prisma } from '@talk2tax/database';
import { GuardViolation } from '@talk2tax/document-db';

/** A record as Prisma returns it (camelCase fields, Prisma.Decimal, Date). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Op = 'INSERT' | 'UPDATE' | 'DELETE';

/** Prisma-style reads of other records, answered from MongoDB inside the write's transaction. */
export type Reader = Record<string, { findFirst(args: Row): Promise<Row | null>; findMany(args: Row): Promise<Row[]>; count(args: Row): Promise<number> }>;

export interface GuardContext {
  db: Reader;
  /** A transaction-local switch set with `allowInTx` (what `set_config('t2t.<name>', 'on', true)` was). */
  allowed(name: string): boolean;
}

/**
 * The rule of a table, run on every write to it before the write commits (the PostgreSQL
 * trigger it replaces is named next to each). `before` is the record as it stood (null on
 * insert), `after` the record as written (null on delete). Throwing undoes the whole transaction.
 */
export type Guard = (op: Op, before: Row | null, after: Row | null, ctx: GuardContext) => void | Promise<void>;

/** A guard as written: `o` (OLD) is null on insert and `n` (NEW) on delete, so check `op` first. */
export type Rule = (op: Op, o: Row, n: Row, ctx: GuardContext) => void | Promise<void>;

/** A rule was broken: the API answers 409 LEDGER_INTEGRITY with the reason, as it did for the trigger. */
export const fail = (reason: string): never => {
  throw new GuardViolation(reason);
};

/**
 * The record with a check on every field read: a misspelt field name throws instead of quietly
 * reading as NULL. Records reach guards with all their columns.
 */
export function strict(row: Row | null, model: string): Row | null {
  if (!row) return row;
  return new Proxy(row, {
    get(t, p) {
      if (typeof p === 'string' && !(p in t) && p !== 'then' && p !== 'toJSON') throw new Error(`${model} has no field ${p}`);
      return Reflect.get(t, p);
    },
  });
}

const norm = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (Prisma.Decimal.isDecimal(v)) return (v as Prisma.Decimal).toFixed();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return canonical(v);
  if (v !== null && typeof v === 'object') return canonical(v);
  return v;
};

/** JSON with keys sorted, so two equal JSON values compare equal whatever order their keys came in. */
const canonical = (v: unknown): string => {
  if (Prisma.Decimal.isDecimal(v)) return JSON.stringify((v as Prisma.Decimal).toFixed());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
};

/** SQL `a IS DISTINCT FROM b`: NULLs compare equal to each other. */
export const differs = (a: unknown, b: unknown): boolean => {
  const x = norm(a);
  const y = norm(b);
  if (x === null || y === null) return x !== y;
  if (Prisma.Decimal.isDecimal(a) || Prisma.Decimal.isDecimal(b)) return !new Prisma.Decimal(String(a)).eq(String(b));
  return x !== y;
};

/** SQL `a <> b`: unknown (so false) when either is NULL. */
export const ne = (a: unknown, b: unknown): boolean => norm(a) !== null && norm(b) !== null && differs(a, b);

/** Any of these fields IS DISTINCT FROM between the two records. */
export const changed = (before: Row, after: Row, fields: string[]): boolean => fields.some((f) => differs(before[f], after[f]));

/** Any of these fields `<>` between the two records (NULL on either side does not count). */
export const changedNe = (before: Row, after: Row, fields: string[]): boolean => fields.some((f) => ne(before[f], after[f]));

/** Every field but these IS DISTINCT FROM between the two records. */
export const changedExcept = (before: Row, after: Row, keep: string[]): boolean =>
  Object.keys({ ...before, ...after }).some((f) => !keep.includes(f) && differs(before[f], after[f]));

/** A table that only ever gains records. */
export const appendOnlyRule = (reason: string): Rule => (op) => {
  if (op !== 'INSERT') fail(reason);
};

export const dec = (v: unknown) => new Prisma.Decimal(v === null || v === undefined ? 0 : String(v));
