import { Prisma } from '@talk2tax/database';

/**
 * A small evaluator for the expressions PostgreSQL prints for CHECK constraints
 * (`pg_get_constraintdef`), so the API can hold MongoDB records to the same checks. It covers
 * what the schema's checks use: AND/OR/NOT, comparisons, IS [NOT] NULL, IS [NOT] DISTINCT FROM,
 * `= ANY (ARRAY[...])`, `<> ALL`, `<@`, regular expressions, CASE, POSITION, TRIM, arithmetic on
 * numerics, dates and intervals, casts, and the text, array, byte and JSON functions in use.
 * NULL is SQL's unknown: a check fails only on FALSE.
 */

type Value = unknown;
type Node =
  | { k: 'lit'; v: Value }
  | { k: 'col'; name: string }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'is'; a: Node; not: boolean; what: 'NULL' | 'TRUE' | 'FALSE' }
  | { k: 'distinct'; a: Node; b: Node; not: boolean }
  | { k: 'quant'; op: string; a: Node; q: 'ANY' | 'ALL'; b: Node }
  | { k: 'in'; a: Node; list: Node[]; not: boolean }
  | { k: 'cast'; a: Node; type: string }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'array'; items: Node[] }
  | { k: 'case'; subject: Node | null; whens: [Node, Node][]; else: Node | null };

// ------------------------------------------------------------------ tokens

interface Tok {
  t: 'id' | 'qid' | 'num' | 'str' | 'op' | 'end';
  v: string;
}

const OPS = ['::', '<>', '!=', '<=', '>=', '->>', '->', '<@', '@>', '||', '!~*', '!~', '~*', '(', ')', ',', '=', '<', '>', '+', '-', '*', '/', '~', '[', ']', '%', '?'];

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`Unterminated string in ${src}`);
        if (src[i] === "'" && src[i + 1] === "'") ((s += "'"), (i += 2));
        else if (src[i] === "'") {
          i++;
          break;
        } else s += src[i++];
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      out.push({ t: 'qid', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`Unexpected "${c}" in ${src}`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'end', v: '' });
  return out;
}

// ------------------------------------------------------------------ parser

const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'DISTINCT',
  'FROM',
  'ANY',
  'ALL',
  'ARRAY',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'BOTH',
  'LEADING',
  'TRAILING',
]);
const kw = (t: Tok, w: string) => t.t === 'id' && t.v.toUpperCase() === w;

class Parser {
  private i = 0;
  constructor(
    private readonly ts: Tok[],
    private readonly src: string,
  ) {}

  private peek(o = 0) {
    return this.ts[this.i + o];
  }
  private next() {
    return this.ts[this.i++];
  }
  private isOp(v: string, o = 0) {
    const t = this.peek(o);
    return t.t === 'op' && t.v === v;
  }
  private expectOp(v: string) {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v) throw new Error(`Expected "${v}" but found "${t.v}" in ${this.src}`);
  }
  private expectKw(w: string) {
    const t = this.next();
    if (!kw(t, w)) throw new Error(`Expected ${w} but found "${t.v}" in ${this.src}`);
  }
  private acceptKw(w: string) {
    if (kw(this.peek(), w)) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const n = this.or();
    if (this.peek().t !== 'end') throw new Error(`Unexpected "${this.peek().v}" in ${this.src}`);
    return n;
  }

  private or(): Node {
    let a = this.and();
    while (this.acceptKw('OR')) a = { k: 'bin', op: 'OR', a, b: this.and() };
    return a;
  }
  private and(): Node {
    let a = this.not();
    while (this.acceptKw('AND')) a = { k: 'bin', op: 'AND', a, b: this.not() };
    return a;
  }
  private not(): Node {
    if (this.acceptKw('NOT')) return { k: 'un', op: 'NOT', a: this.not() };
    return this.predicate();
  }
  private predicate(): Node {
    const a = this.concat();
    for (;;) {
      if (kw(this.peek(), 'IS')) {
        this.i++;
        const not = this.acceptKw('NOT');
        if (this.acceptKw('DISTINCT')) {
          this.expectKw('FROM');
          return { k: 'distinct', a, b: this.concat(), not };
        }
        const w = this.next().v.toUpperCase();
        if (w !== 'NULL' && w !== 'TRUE' && w !== 'FALSE') throw new Error(`IS ${w} is not supported in ${this.src}`);
        return { k: 'is', a, not, what: w };
      }
      const notIn = kw(this.peek(), 'NOT') && (kw(this.peek(1), 'IN') || kw(this.peek(1), 'LIKE'));
      if (notIn) this.i++;
      if (this.acceptKw('IN')) {
        this.expectOp('(');
        const list = [this.or()];
        while (this.isOp(',')) (this.i++, list.push(this.or()));
        this.expectOp(')');
        return { k: 'in', a, list, not: notIn };
      }
      if (this.acceptKw('LIKE')) {
        const b = this.concat();
        const like: Node = { k: 'bin', op: 'LIKE', a, b };
        return notIn ? { k: 'un', op: 'NOT', a: like } : like;
      }
      if (this.acceptKw('BETWEEN')) {
        const lo = this.concat();
        this.expectKw('AND');
        const hi = this.concat();
        return { k: 'bin', op: 'AND', a: { k: 'bin', op: '>=', a, b: lo }, b: { k: 'bin', op: '<=', a, b: hi } };
      }
      const t = this.peek();
      if (t.t === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>=', '~', '~*', '!~', '!~*', '<@', '@>', '?'].includes(t.v)) {
        this.i++;
        const op = t.v === '!=' ? '<>' : t.v;
        if (kw(this.peek(), 'ANY') || kw(this.peek(), 'ALL')) {
          const q = this.next().v.toUpperCase() as 'ANY' | 'ALL';
          this.expectOp('(');
          const b = this.or();
          this.expectOp(')');
          return { k: 'quant', op, a, q, b };
        }
        // Comparisons do not chain in SQL; a following comparison belongs to an outer level.
        return { k: 'bin', op, a, b: this.concat() };
      }
      return a;
    }
  }
  private concat(): Node {
    let a = this.additive();
    while (this.isOp('||')) (this.i++, (a = { k: 'bin', op: '||', a, b: this.additive() }));
    return a;
  }
  private additive(): Node {
    let a = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.multiplicative() };
    }
    return a;
  }
  private multiplicative(): Node {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Node {
    if (this.isOp('-')) {
      this.i++;
      return { k: 'un', op: '-', a: this.unary() };
    }
    return this.postfix();
  }
  private postfix(): Node {
    let a = this.primary();
    for (;;) {
      if (this.isOp('::')) {
        this.i++;
        a = { k: 'cast', a, type: this.typeName() };
      } else if (this.isOp('->') || this.isOp('->>')) {
        const op = this.next().v;
        a = { k: 'bin', op, a, b: this.primaryCast() };
      } else if (kw(this.peek(), 'AT') && kw(this.peek(1), 'TIME') && kw(this.peek(2), 'ZONE')) {
        this.i += 3;
        a = { k: 'call', fn: '__at_time_zone', args: [a, this.primaryCast()] };
      } else if (this.isOp('[')) {
        this.i++;
        const idx = this.or();
        this.expectOp(']');
        a = { k: 'call', fn: '__index', args: [a, idx] };
      } else return a;
    }
  }
  /** A primary with its casts (the zone of AT TIME ZONE). */
  private primaryCast(): Node {
    let a = this.primary();
    while (this.isOp('::')) (this.i++, (a = { k: 'cast', a, type: this.typeName() }));
    return a;
  }
  private typeName(): string {
    const t = this.next();
    let name = t.v;
    // Multi-word types: character varying, double precision, timestamp with(out) time zone.
    while (this.peek().t === 'id' && !KEYWORDS.has(this.peek().v.toUpperCase())) name += ' ' + this.next().v;
    if (this.isOp('(')) {
      while (!this.isOp(')')) this.i++;
      this.i++;
    }
    if (this.isOp('[') && this.isOp(']', 1)) ((this.i += 2), (name += '[]'));
    return name.toLowerCase();
  }
  private primary(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'lit', v: new Prisma.Decimal(t.v) };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'qid') {
      // A quoted name followed by "(" is a function whose name is a keyword ("left"(gstin, 2)).
      if (!this.isOp('(')) return { k: 'col', name: t.v };
      this.i--;
      this.ts[this.i] = { t: 'id', v: t.v };
      return this.primary();
    }
    if (t.t === 'op' && t.v === '(') {
      const n = this.or();
      this.expectOp(')');
      return n;
    }
    if (t.t === 'id') {
      const up = t.v.toUpperCase();
      if (up === 'NULL') return { k: 'lit', v: null };
      if (up === 'TRUE') return { k: 'lit', v: true };
      if (up === 'FALSE') return { k: 'lit', v: false };
      if (up === 'ARRAY') {
        this.expectOp('[');
        const items: Node[] = [];
        if (!this.isOp(']')) {
          items.push(this.or());
          while (this.isOp(',')) (this.i++, items.push(this.or()));
        }
        this.expectOp(']');
        return { k: 'array', items };
      }
      if (up === 'CASE') {
        const subject = kw(this.peek(), 'WHEN') ? null : this.or();
        const whens: [Node, Node][] = [];
        while (this.acceptKw('WHEN')) {
          const w = this.or();
          this.expectKw('THEN');
          whens.push([w, this.or()]);
        }
        const els = this.acceptKw('ELSE') ? this.or() : null;
        this.expectKw('END');
        return { k: 'case', subject, whens, else: els };
      }
      if (up === 'POSITION' && this.isOp('(')) {
        this.i++;
        const needle = this.concat();
        this.expectKw('IN');
        const hay = this.concat();
        this.expectOp(')');
        return { k: 'call', fn: 'position', args: [needle, hay] };
      }
      if ((up === 'EXTRACT' || up === 'DATE_PART') && this.isOp('(') && this.peek(1).t === 'id' && kw(this.peek(2), 'FROM')) {
        this.i++;
        const field = this.next().v.toLowerCase();
        this.expectKw('FROM');
        const a = this.or();
        this.expectOp(')');
        return { k: 'call', fn: 'extract', args: [{ k: 'lit', v: field }, a] };
      }
      if (up === 'TRIM' && this.isOp('(')) {
        this.i++;
        let mode = 'both';
        if (['BOTH', 'LEADING', 'TRAILING'].includes(this.peek().v.toUpperCase())) mode = this.next().v.toLowerCase();
        this.expectKw('FROM');
        const a = this.or();
        this.expectOp(')');
        return { k: 'call', fn: mode === 'both' ? 'btrim' : mode === 'leading' ? 'ltrim' : 'rtrim', args: [a] };
      }
      if (this.isOp('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          args.push(this.or());
          while (this.isOp(',')) (this.i++, args.push(this.or()));
        }
        this.expectOp(')');
        return { k: 'call', fn: t.v.toLowerCase(), args };
      }
      return { k: 'col', name: t.v };
    }
    throw new Error(`Unexpected "${t.v}" in ${this.src}`);
  }
}

/** Parses a constraint as `pg_get_constraintdef` prints it (`CHECK (...)`, possibly `NOT VALID`). */
export function parseCheck(def: string): Node {
  const body = def.replace(/\s+NOT VALID\s*$/i, '').replace(/^CHECK\s*/i, '');
  return new Parser(tokens(body), def).parse();
}

// ------------------------------------------------------------------ values

const isDec = (v: unknown): v is Prisma.Decimal => Prisma.Decimal.isDecimal(v);
const toDec = (v: unknown): Prisma.Decimal => (isDec(v) ? v : new Prisma.Decimal(typeof v === 'bigint' ? v.toString() : (v as number | string)));
const isNumeric = (v: unknown) => isDec(v) || typeof v === 'number' || typeof v === 'bigint';
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/** An interval, in milliseconds (the checks use hour:minute:second and day intervals). */
class Interval {
  constructor(readonly ms: number) {}
}

function parseInterval(s: string): Interval {
  let ms = 0;
  const hms = /(-?\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  if (hms) ms += (+hms[1] * 3600 + +hms[2] * 60 + +hms[3]) * 1000;
  for (const [, n, unit] of s.matchAll(/(-?\d+(?:\.\d+)?)\s*(day|days|hour|hours|mon|mons|month|months|year|years|min|mins|minute|minutes|sec|secs|second|seconds)\b/gi)) {
    const u = unit.toLowerCase();
    const f = u.startsWith('day') ? 86400e3 : u.startsWith('hour') ? 3600e3 : u.startsWith('min') ? 60e3 : u.startsWith('sec') ? 1e3 : u.startsWith('mon') ? 30 * 86400e3 : 365.25 * 86400e3;
    ms += +n * f;
  }
  return new Interval(ms);
}

/** Orders two non-null values the way PostgreSQL compares them. */
function compare(a: Value, b: Value): number {
  if (isNumeric(a) || isNumeric(b)) return toDec(a).comparedTo(toDec(b));
  if (a instanceof Date || b instanceof Date) return +new Date(a as Date) - +new Date(b as Date);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Interval && b instanceof Interval) return a.ms - b.ms;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const equal = (a: Value, b: Value) => compare(a, b) === 0;
const sqlNot = (v: Value) => (v === null ? null : !v);
const trimSpaces = (s: string, mode: 'both' | 'l' | 'r') => (mode === 'l' ? s.replace(/^ +/, '') : mode === 'r' ? s.replace(/ +$/, '') : s.replace(/^ +| +$/g, ''));

function jsonType(v: Value): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return 'array';
  if (isNumeric(v)) return 'number';
  if (typeof v === 'object') return 'object';
  return typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'boolean' : 'number';
}

function cast(v: Value, type: string): Value {
  if (v === null || v === undefined) return null;
  const t = type.replace(/\[\]$/, '');
  if (type.endsWith('[]')) return v;
  if (['numeric', 'integer', 'bigint', 'smallint', 'int', 'int4', 'int8', 'double precision', 'real', 'decimal'].includes(t)) {
    const d = toDec(typeof v === 'string' ? v.trim() : v);
    return ['integer', 'bigint', 'smallint', 'int', 'int4', 'int8'].includes(t) ? d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP) : d;
  }
  if (t === 'interval') return typeof v === 'string' ? parseInterval(v) : v;
  if (t === 'date') {
    const d = new Date(v as string);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  if (t.startsWith('timestamp')) return new Date(v as string);
  if (t === 'jsonb' || t === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
  if (t === 'boolean' || t === 'bool') return typeof v === 'string' ? ['t', 'true', 'y', 'yes', 'on', '1'].includes(v.toLowerCase()) : !!v;
  if (t === 'text' || t === 'character varying' || t === 'varchar' || t === 'bpchar' || t === 'character' || t === 'char') {
    if (isDec(v) || typeof v === 'number' || typeof v === 'bigint') return toDec(v).toString();
    return typeof v === 'string' ? (t === 'bpchar' || t === 'character' || t === 'char' ? v.replace(/ +$/, '') : v) : v;
  }
  return v; // enum casts and the like
}

function call(fn: string, args: Value[]): Value {
  const [a, b, c] = args;
  switch (fn) {
    case 'length':
    case 'char_length':
    case 'character_length':
      return a === null ? null : new Prisma.Decimal([...String(a)].length);
    case 'octet_length':
      return a === null ? null : new Prisma.Decimal(isBytes(a) ? a.byteLength : Buffer.byteLength(String(a)));
    case 'btrim':
      return a === null ? null : trimSpaces(String(a), 'both');
    case 'ltrim':
      return a === null ? null : trimSpaces(String(a), 'l');
    case 'rtrim':
      return a === null ? null : trimSpaces(String(a), 'r');
    case 'lower':
      return a === null ? null : String(a).toLowerCase();
    case 'upper':
      return a === null ? null : String(a).toUpperCase();
    case 'substr':
    case 'substring': {
      if (a === null || b === null) return null;
      const chars = [...String(a)];
      const from = toDec(b).toNumber() - 1;
      const len = c === undefined ? chars.length : toDec(c).toNumber();
      return chars.slice(Math.max(from, 0), Math.max(from + len, 0)).join('');
    }
    case 'left':
    case 'right': {
      if (a === null || b === null) return null;
      const chars = [...String(a)];
      const k = toDec(b).toNumber();
      const n = k < 0 ? Math.max(chars.length + k, 0) : k;
      return (fn === 'left' ? chars.slice(0, n) : chars.slice(chars.length - n)).join('');
    }
    case 'extract':
    case 'date_part': {
      if (b === null) return null;
      const d = b as Date;
      const f = String(a).toLowerCase();
      const v = f === 'day' ? d.getUTCDate() : f === 'month' ? d.getUTCMonth() + 1 : f === 'year' ? d.getUTCFullYear() : f === 'dow' ? d.getUTCDay() : f === 'hour' ? d.getUTCHours() : f === 'epoch' ? +d / 1000 : NaN;
      if (Number.isNaN(v)) throw new Error(`EXTRACT(${f}) is not supported in checks`);
      return new Prisma.Decimal(v);
    }
    case 'position':
      return a === null || b === null ? null : new Prisma.Decimal(String(b).indexOf(String(a)) + 1);
    case 'abs':
      return a === null ? null : toDec(a).abs();
    case 'round':
      return a === null ? null : toDec(a).toDecimalPlaces(b === undefined ? 0 : toDec(b).toNumber(), Prisma.Decimal.ROUND_HALF_UP);
    case 'coalesce':
      return args.find((x) => x !== null && x !== undefined) ?? null;
    case 'num_nonnulls':
      return new Prisma.Decimal(args.filter((x) => x !== null && x !== undefined).length);
    case 'num_nulls':
      return new Prisma.Decimal(args.filter((x) => x === null || x === undefined).length);
    case 'cardinality':
      return a === null ? null : new Prisma.Decimal((a as unknown[]).length);
    case 'array_length':
      return a === null || !(a as unknown[]).length ? null : new Prisma.Decimal((a as unknown[]).length);
    case 'jsonb_typeof':
    case 'json_typeof':
      return jsonType(a);
    case 'jsonb_array_length':
    case 'json_array_length':
      if (a === null) return null;
      if (!Array.isArray(a)) throw new SqlError('cannot get array length of a non-array');
      return new Prisma.Decimal(a.length);
    case '__index':
      return a === null || b === null ? null : ((a as unknown[])[toDec(b).toNumber() - 1] ?? null);
    case 'now':
      return new Date();
    case '__at_time_zone':
      // A timestamptz at a zone is that zone's wall-clock time, kept here as the same fields in UTC.
      return a === null || b === null ? null : wallClock(a as Date, String(b));
    default:
      throw new Error(`The function ${fn}() is not supported in checks`);
  }
}

function wallClock(t: Date, zone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(t)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second, t.getUTCMilliseconds()));
}

/** An error PostgreSQL itself would raise while evaluating (a check that errors refuses the row). */
export class SqlError extends Error {}

function likeToRegExp(p: string, flags = '') {
  return new RegExp(
    `^${p
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.')}$`,
    `s${flags}`,
  );
}

function evaluate(n: Node, row: Record<string, unknown>): Value {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'col': {
      if (!(n.name in row)) throw new Error(`The check names a column ${n.name} the record does not have`);
      const v = row[n.name];
      return v === undefined ? null : v;
    }
    case 'un': {
      const a = evaluate(n.a, row);
      if (n.op === 'NOT') return sqlNot(a);
      return a === null ? null : toDec(a).neg();
    }
    case 'is': {
      const a = evaluate(n.a, row);
      const r = n.what === 'NULL' ? a === null : n.what === 'TRUE' ? a === true : a === false;
      return n.not ? !r : r;
    }
    case 'distinct': {
      const a = evaluate(n.a, row);
      const b = evaluate(n.b, row);
      const differ = a === null || b === null ? (a === null) !== (b === null) : !equal(a, b);
      return n.not ? !differ : differ;
    }
    case 'in': {
      const a = evaluate(n.a, row);
      const r = anyOf(
        n.list.map((x) => evaluate(x, row)),
        (x) => cmp('=', a, x),
      );
      return n.not ? sqlNot(r) : r;
    }
    case 'quant': {
      const a = evaluate(n.a, row);
      const list = evaluate(n.b, row);
      if (list === null) return null;
      const items = list as Value[];
      return n.q === 'ANY' ? anyOf(items, (x) => cmp(n.op, a, x)) : allOf(items, (x) => cmp(n.op, a, x));
    }
    case 'array':
      return n.items.map((x) => evaluate(x, row));
    case 'cast':
      return cast(evaluate(n.a, row), n.type);
    case 'call':
      return call(
        n.fn,
        n.args.map((x) => evaluate(x, row)),
      );
    case 'case': {
      const subject = n.subject ? evaluate(n.subject, row) : undefined;
      for (const [w, then] of n.whens) {
        const hit = n.subject ? cmp('=', subject, evaluate(w, row)) : evaluate(w, row);
        if (hit === true) return evaluate(then, row);
      }
      return n.else ? evaluate(n.else, row) : null;
    }
    case 'bin': {
      if (n.op === 'AND') {
        const a = evaluate(n.a, row);
        if (a === false) return false;
        const b = evaluate(n.b, row);
        if (b === false) return false;
        return a === null || b === null ? null : true;
      }
      if (n.op === 'OR') {
        const a = evaluate(n.a, row);
        if (a === true) return true;
        const b = evaluate(n.b, row);
        if (b === true) return true;
        return a === null || b === null ? null : false;
      }
      const a = evaluate(n.a, row);
      const b = evaluate(n.b, row);
      if (n.op === '->' || n.op === '->>') {
        if (a === null || b === null || typeof a !== 'object') return null;
        const v = Array.isArray(a) ? a[toDec(b).toNumber()] : (a as Record<string, unknown>)[String(b)];
        if (v === undefined) return null;
        return n.op === '->>' && typeof v === 'object' && v !== null ? JSON.stringify(v) : n.op === '->>' && v !== null ? String(v) : v;
      }
      return cmp(n.op, a, b);
    }
  }
}

function anyOf(items: Value[], f: (x: Value) => Value): Value {
  let unknown = false;
  for (const x of items) {
    const r = f(x);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

function allOf(items: Value[], f: (x: Value) => Value): Value {
  let unknown = false;
  for (const x of items) {
    const r = f(x);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

function cmp(op: string, a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  switch (op) {
    case '=':
      return equal(a, b);
    case '<>':
      return !equal(a, b);
    case '<':
      return compare(a, b) < 0;
    case '>':
      return compare(a, b) > 0;
    case '<=':
      return compare(a, b) <= 0;
    case '>=':
      return compare(a, b) >= 0;
    case '~':
      return new RegExp(String(b)).test(String(a));
    case '~*':
      return new RegExp(String(b), 'i').test(String(a));
    case '!~':
      return !new RegExp(String(b)).test(String(a));
    case '!~*':
      return !new RegExp(String(b), 'i').test(String(a));
    case 'LIKE':
      return likeToRegExp(String(b)).test(String(a));
    case '<@':
      return (a as Value[]).every((x) => (b as Value[]).some((y) => x !== null && y !== null && equal(x, y)));
    case '@>':
      return (b as Value[]).every((x) => (a as Value[]).some((y) => x !== null && y !== null && equal(x, y)));
    case '?':
      // jsonb: the key (of an object) or the string (in an array) is there.
      return Array.isArray(a) ? a.some((x) => x === b) : typeof a === 'object' && Object.prototype.hasOwnProperty.call(a, String(b));
    case '||':
      return Array.isArray(a) ? [...a, ...(Array.isArray(b) ? b : [b])] : String(a) + String(b);
    case '+':
      if (a instanceof Date) return new Date(+a + (b instanceof Interval ? b.ms : toDec(b).toNumber() * 86400e3));
      if (a instanceof Interval && b instanceof Interval) return new Interval(a.ms + b.ms);
      return toDec(a).plus(toDec(b));
    case '-':
      if (a instanceof Date && b instanceof Date) return new Interval(+a - +b);
      if (a instanceof Date) return new Date(+a - (b instanceof Interval ? b.ms : toDec(b).toNumber() * 86400e3));
      return toDec(a).minus(toDec(b));
    case '*':
      return toDec(a).times(toDec(b));
    case '/':
      if (toDec(b).isZero()) throw new SqlError('division by zero');
      return toDec(a).div(toDec(b));
    case '%':
      return toDec(a).mod(toDec(b));
    default:
      throw new Error(`The operator ${op} is not supported in checks`);
  }
}

/** An expression's value for a record (an index key such as `lower(name)`). */
export function valueOf(expr: Node, row: Record<string, unknown>): unknown {
  return evaluate(expr, row);
}

/** Whether a predicate is TRUE for the record (a partial index holds only those rows). */
export function holds(predicate: Node, row: Record<string, unknown>): boolean {
  try {
    return evaluate(predicate, row) === true;
  } catch (e) {
    if (e instanceof SqlError) return false;
    throw e;
  }
}

/** Whether a record passes a parsed check: TRUE or NULL passes, FALSE (or an evaluation error) fails. */
export function passes(check: Node, row: Record<string, unknown>): boolean {
  try {
    return evaluate(check, row) !== false;
  } catch (e) {
    if (e instanceof SqlError) return false;
    throw e;
  }
}
