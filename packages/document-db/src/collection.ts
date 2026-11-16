import type { Document, IndexDescription } from 'mongodb';
import { isPlainObject, toDecimal128 } from './decimal';

/** The field every tenant document carries; the data layer adds it to every query. */
export const TENANT_FIELD = 'orgId';

/**
 * Replacement for a PostgreSQL trigger. Guards run inside the write's transaction, so a
 * guard that throws undoes the whole write (and everything else in that transaction).
 */
export interface CollectionGuards<T> {
  /** Before a document is inserted. */
  beforeInsert?: (doc: T, ctx: GuardContext) => void | Promise<void>;
  /** After an update, with the document as it was and as it is now (same transaction). */
  afterUpdate?: (before: T, after: T, ctx: GuardContext) => void | Promise<void>;
  /** Before a document is deleted. */
  beforeDelete?: (doc: T, ctx: GuardContext) => void | Promise<void>;
}

export interface GuardContext {
  /** Look up related documents inside the same transaction (reference checks). */
  collection: <U extends Document>(def: CollectionDef<U>) => import('./scoped-collection').ScopedCollection<U>;
}

export interface CollectionDef<T extends Document = Document> {
  readonly name: string;
  /** tenant: every document belongs to one organisation (orgId). global: shared (users, plans). */
  readonly scope: 'tenant' | 'global';
  /**
   * Paths holding money or quantities, stored as Decimal128. Use [] for array elements:
   * 'lines[].debit'. Values written there must be decimal strings.
   */
  readonly decimals?: readonly string[];
  /** A $jsonSchema validator (the CHECK constraints). orgId is required automatically for tenant collections. */
  readonly schema?: Document;
  readonly indexes?: readonly IndexDescription[];
  /** No updates or deletes, ever (audit trails, event logs). */
  readonly appendOnly?: boolean;
  readonly guards?: CollectionGuards<T>;
  /** Marker for typing only. */
  readonly __type?: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCollectionDef = CollectionDef<any>;

export function defineCollection<T extends Document>(def: CollectionDef<T>): CollectionDef<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`Collection name "${def.name}" must be snake_case`);
  for (const path of def.decimals ?? []) splitDefPath(path);
  return def;
}

/** The validator stored in MongoDB: the definition's schema plus the tenant rule. */
export function validatorFor(def: AnyCollectionDef): Document | undefined {
  const schema: Document = def.schema ? structuredClone(def.schema) : {};
  if (def.scope === 'tenant') {
    schema.bsonType ??= 'object';
    schema.required = Array.from(new Set([...(schema.required ?? []), TENANT_FIELD]));
    schema.properties = { ...(schema.properties ?? {}), [TENANT_FIELD]: { bsonType: 'string', minLength: 1 } };
  }
  for (const path of def.decimals ?? []) addDecimalToSchema(schema, splitDefPath(path));
  return Object.keys(schema).length ? { $jsonSchema: schema } : undefined;
}

/**
 * Adds bsonType "decimal" (or null) at a path, through nested objects and arrays, so a
 * double cannot get in even through code that skips the data layer.
 */
function addDecimalToSchema(schema: Document, segs: string[]): void {
  const [head, ...rest] = segs;
  if (head === ARRAY) {
    schema.bsonType ??= 'array';
    if (!rest.length) {
      schema.items = { bsonType: ['decimal', 'null'] };
      return;
    }
    schema.items ??= {};
    addDecimalToSchema(schema.items, rest);
    return;
  }
  schema.bsonType ??= 'object';
  schema.properties ??= {};
  if (!rest.length) {
    schema.properties[head] = { ...(schema.properties[head] ?? {}), bsonType: ['decimal', 'null'] };
    return;
  }
  schema.properties[head] ??= {};
  addDecimalToSchema(schema.properties[head], rest);
}

// ---------------------------------------------------------------------------------------
// Decimal paths

const ARRAY = '[]';

export function splitDefPath(path: string): string[] {
  const segs = path.replace(/\[\]/g, '.[]').split('.').filter(Boolean);
  if (!segs.length || segs[0] === ARRAY) throw new Error(`Bad decimal path "${path}"`);
  return segs;
}

/** An update or filter key ("lines.0.debit", "lines.$[].debit") in the same form. */
function splitKey(key: string): string[] {
  return key.split('.').map((s) => (/^\d+$/.test(s) || s.startsWith('$') ? ARRAY : s));
}

/** Converts decimal strings at the given path inside a value (objects and arrays). */
function encodeAt(value: unknown, segs: string[], fullPath: string, allowNull: boolean): unknown {
  if (segs.length === 0) {
    if (value === null || value === undefined) return value;
    return toDecimal128(value, fullPath);
  }
  const [head, ...rest] = segs;
  if (head === ARRAY) {
    if (!Array.isArray(value)) return value;
    return value.map((v) => encodeAt(v, rest, fullPath, allowNull));
  }
  if (Array.isArray(value)) {
    // Mongo paths through arrays without [] still address every element.
    return value.map((v) => encodeAt(v, segs, fullPath, allowNull));
  }
  if (!isPlainObject(value) || !(head in value)) return value;
  return { ...value, [head]: encodeAt(value[head], rest, fullPath, allowNull) };
}

/** Encodes every decimal path of a whole document (inserts and replacements). */
export function encodeDocument<T>(def: AnyCollectionDef, doc: T): T {
  let out: unknown = doc;
  for (const path of def.decimals ?? []) out = encodeAt(out, splitDefPath(path), path, true);
  return out as T;
}

/** If key addresses (part of) a decimal path, returns the remaining segments. */
function remainderFor(keySegs: string[], defSegs: string[]): string[] | undefined {
  if (keySegs.length > defSegs.length) return undefined;
  let d = 0;
  for (const k of keySegs) {
    // A key may skip an array marker ("lines.debit" also reaches lines[].debit).
    if (defSegs[d] === ARRAY && k !== ARRAY) d++;
    if (defSegs[d] !== k) return undefined;
    d++;
  }
  return defSegs.slice(d);
}

/**
 * Encodes the values of a { key: value } map (an update operator's body). For $push and
 * $addToSet (`element`), each value is one array element, or { $each: [...] }.
 */
export function encodeKeyed(def: AnyCollectionDef, body: Record<string, unknown>, element = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const key of Object.keys(out)) {
    const keySegs = element ? [...splitKey(key), ARRAY] : splitKey(key);
    for (const path of def.decimals ?? []) {
      const rest = remainderFor(keySegs, splitDefPath(path));
      if (!rest) continue;
      const value = out[key];
      if (element && isPlainObject(value) && Array.isArray(value.$each)) {
        out[key] = { ...value, $each: value.$each.map((v) => encodeAt(v, rest, path, true)) };
      } else {
        out[key] = encodeAt(value, rest, path, true);
      }
    }
  }
  return out;
}

const COMPARISON = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST = new Set(['$in', '$nin']);

/** Encodes decimal comparisons in a filter: { total: "10.00" }, { total: { $gt: "0" } }, $and/$or. */
export function encodeFilter(def: AnyCollectionDef, filter: Document): Document {
  if (!def.decimals?.length) return filter;
  const out: Document = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      out[key] = (value as Document[]).map((f) => encodeFilter(def, f));
      continue;
    }
    const keySegs = splitKey(key);
    const isDecimal = (def.decimals ?? []).some((p) => {
      const rest = remainderFor(keySegs, splitDefPath(p));
      return rest !== undefined && rest.every((s) => s === ARRAY);
    });
    if (!isDecimal) {
      out[key] = value;
    } else if (isPlainObject(value) && Object.keys(value).some((k) => k.startsWith('$'))) {
      const ops: Document = {};
      for (const [op, v] of Object.entries(value)) {
        if (COMPARISON.has(op)) ops[op] = v === null ? null : toDecimal128(v, key);
        else if (LIST.has(op)) ops[op] = (v as unknown[]).map((x) => (x === null ? null : toDecimal128(x, key)));
        else ops[op] = v;
      }
      out[key] = ops;
    } else {
      out[key] = value === null ? null : toDecimal128(value, key);
    }
  }
  return out;
}
